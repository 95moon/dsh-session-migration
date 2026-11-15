    /** 「会话迁移」在侧栏图标列表里的入口 id —— 同时也是它落地的主区面板 key。
     *
     *  宿主对 sidebar.panellist 的约定是「列表 id 指向同名 main 面板」：侧栏自己画按钮、
     *  按列表项的 label 出文案，点下去把主区切到 `main` 的同名 cell。因此两处必须用同一个
     *  字符串，缺一个就是「有图标、点开一片空白」。（dsh-context 是同款成对注册：
     *  panellist 的 id 与 main 的 key 都是 'dsh-context'。） */
    const PANEL_KEY = "session-migration";

    /** 把侧栏入口与主区整页一起登记/撤销，返回撤销函数列表。
     *
     *  为什么用 slots.inject 而不是裸 register：槽由 ui-sidebar 声明，时机晚于本插件
     *  apply 期（advanced shell 下更不保证顺序）；裸 register 在槽未声明时会抛错，把
     *  renderer 的 boot 判成失败（白屏）。inject 是「声明就绪时再注册」的时序机制。
     *
     *  图形与文案都交给宿主：panellist 只收 id / order / label，图标由注册的组件按
     *  ownerProps { size, active } 自己画（见 panel-page.js 的 MigrationPanelIcon）。 */
    function registerSidebarEntry(ctx) {
      const disposers = [];
      const keep = (dispose) => { if (typeof dispose === "function") disposers.push(dispose); };
      const entryLabel = () => (localeSvc ? localeSvc.bind(LOCALE_NS)("trigger.label") : (DICT.zh["trigger.label"] || "会话迁移"));
      const drop = () => {
        for (const d of disposers) { try { d(); } catch (_) {} }
        disposers.length = 0;
      };
      try {
        // order 15：排在宿主自己的「插件」(0) /「自动化任务」(10) 之后、「上下文洞察」(20)
        // 之前——同类工作面板挨着放，又不挤到发布条目中间。
        keep(ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            { name: "sidebar.panellist", id: PANEL_KEY, order: 15, label: entryLabel, locale: LOCALE_NS },
            MigrationPanelIcon,
          )));
        keep(ctx.slots.inject("main", () =>
          ctx.slots.register(
            { name: "main", key: PANEL_KEY, locale: LOCALE_NS },
            MigrationPage,
          )));
      } catch (_) {
        // 半对状态比不注册更糟（图标在、点开空白）：出错就把已登记的那一半撤掉。
        drop();
      }
      return disposers;
    }

    const name = "session-migration";
    // locale 是晚挂载服务（dsh-client-locale 自身依赖 connection/remote），声明进
    // inject 让 apply 期 ctx.get('locale') 就绪（面板 i18n + 字典注册）。sidebarRightTabs
    // 是官方原生右侧栏的 tab 注册服务（dsh ≥ 0.1.5-rc.1 恒有，peerDependencies 已抬
    // 门槛）：声明进 inject = 激活即服务就绪，右侧栏为硬依赖，无回落链。
    const inject = ["slots", "locale", "sidebarRightTabs"];

    function apply(ctx) {
      // 交给 settings.js 的传输层：0.1.7 的设置值走客户端 configForms，需要客户端 ctx。
      setClientHostCtx(ctx);
      // locale 服务（@deepseek-ai/dsh-client-locale）：已声明进 inject，apply 期就绪；
      // 注册面板字典并随 DSH web 语言切换（缺失时 useTranslate 降级内置 zh 字典）。
      const locale = ctx.get("locale");
      if (locale && typeof locale.register === "function" && typeof locale.bind === "function") {
        localeSvc = locale;
        ctx.effect(() => locale.register(LOCALE_NS, { zh: DICT.zh, en: DICT.en }));
      }
      // 官方原生右侧栏（@deepseek-ai/dsh-client-ui-sidebar-right，DSH ≥ 0.1.5-rc.1）是硬
      // 依赖：inject 声明 sidebarRightTabs + peerDependencies 抬门槛，apply 期服务必
      // 就绪——无回落链（better-sidebar 集成与自绘 ShellPanel 已随依赖抬升一并删除）。
      // 注册 tab 类型（id/kind = session-migration，title 供 chip 与 guide 标题）与 guide 胶囊
      //（图标 + 标题 + 描述）；面板主体走 sidebar.right.pane.tab 槽（session 作用域、
      // keyed by 类型 id）。该槽由 ui-sidebar-right 的 rightbar.session 条目声明，晚于
      // 本插件 apply 期 → slots.inject 挂到声明就绪时注册（时序机制，不是回落）。
      const tabs = ctx.get("sidebarRightTabs");
      const label = () => (localeSvc ? localeSvc.bind(LOCALE_NS)("trigger.label") : (DICT.zh["trigger.label"] || "会话迁移"));
      const guideDescription = () => (localeSvc ? localeSvc.bind(LOCALE_NS)("sidebar.guide.description") : (DICT.zh["sidebar.guide.description"] || ""));
      ctx.effect(() => tabs.register({
        id: IMPORT_TAB_TYPE,
        kind: IMPORT_TAB_TYPE,
        title: label,
        guide: [{
          order: 20, // guide 页排在官方 Files（order 10）之后
          title: label,
          description: guideDescription,
          icon: ImportGlyph,
        }],
      }), "dsh-session-migration: 右侧栏 tab 类型注册");
      ctx.slots.inject("sidebar.right.pane.tab", () =>
        ctx.slots.register(
          { name: "sidebar.right.pane.tab", key: IMPORT_TAB_TYPE },
          SidebarImportTab,
        ));
      // 主区整页右上角「在右侧栏打开」用同一个打开面：每次点击重证 sidebarRight 服务——
      // 无挂载会话、服务被 HMR 换掉等失败返回 false，本次点击无动作（依赖门槛保证受支持
      // 版本服务恒存在；参照 dsh-context 的 openContextSidebar；空 catch 吞掉的就是「本次
      // 打开」这一下，下一击重新尝试）。
      openNativeImportTab = () => {
        try {
          const face = ctx.get("sidebarRight");
          if (!face || typeof face.openTab !== "function") return false;
          face.openTab(IMPORT_TAB_TYPE);
          return true;
        } catch (_) {
          return false;
        }
      };
      // 侧栏入口（sidebar.panellist 图标 + 同名 main 整页）按设置项 sidebarButton 开关，
      // 默认开：先按 localStorage 里同步缓存的值落一次（避免首帧闪一个图标又消失），
      // 再把宿主里存的值对齐一次；监听集合让设置页改完即时生效。撤销走 effect 清理，
      // 插件卸载/重载时图标与页面一起消失，不留孤儿 cell。
      ctx.effect(() => {
        let disposers = [];
        const sync = (enabled) => {
          const want = enabled !== false;
          if (want) {
            if (disposers.length === 0) disposers = registerSidebarEntry(ctx);
          } else if (disposers.length > 0) {
            for (const d of disposers) { try { d(); } catch (_) {} }
            disposers = [];
          }
        };
        sync(cachedSidebarButton);
        sidebarButtonListeners.add(sync);
        // 0.1.7 走客户端 configForms，旧宿主走 fenced 路由（loadPrefsView 分流）。
        loadPrefsView()
          .then((d) => {
            if (d && d.ok && d.value && typeof d.value.sidebarButton === "boolean") {
              setSidebarButton(d.value.sidebarButton);
            }
          })
          .catch(() => {});
        return () => {
          sidebarButtonListeners.delete(sync);
          for (const d of disposers) { try { d(); } catch (_) {} }
          disposers = [];
        };
      }, "dsh-session-migration: 侧栏入口与主区整页");
      // 落点 Toast 的挂载点：官方 shell.overlay（与宿主自己的 toast 同一个槽，例如
      // ui-plugin-manager 的 plugin-manager.refresh-toast）。惰性 inject：槽被声明才注册。
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          { name: "shell.overlay", id: "session-migration.landing-toast", locale: LOCALE_NS, inject: () => ({}) },
          ToastHost,
        ));
      // 设置席位按宿主世代分流（对齐 dsh-claude-style）：
      //   0.1.7+ —— 插件页 plugins.bundle.config（键 = 包名），由 ui-plugin-manager 声明，
      //             渲染在「设置 → 插件 → dsh-session-migration」；值走客户端 configForms。
      //   旧宿主 —— settings.section 整页（设置页左侧导航「每功能一页」）；值走 fenced
      //             路由 /api-import/prefs。
      // 两个 slots.inject 都是惰性的：槽被声明才触发（旧宿主不声明 plugins.bundle.config，
      // 新宿主仍声明 settings.section），再用 configForms 是否存在否决整页在新宿主上的
      // 重复注册——否则同一个设置会在两处各长一份。label 用 thunk 跟随语言切换。
      const settingsLabel = () => (localeSvc ? localeSvc.bind(LOCALE_NS)("settings.tab") : (DICT.zh["settings.tab"] || "会话导入"));
      ctx.effect(
        () => registerSettingsNavIcon(settingsLabel),
        "dsh-session-migration: settings navigation icon",
      );
      ctx.slots.inject("plugins.bundle.config", () =>
        ctx.slots.register(
          { name: "plugins.bundle.config", key: "dsh-session-migration", label: settingsLabel },
          ImportSettingsSection,
        ));
      ctx.slots.inject("settings.section", () => {
        if (hostConfigForms()) return undefined;
        return ctx.slots.register(
          { name: "settings.section", id: "session-migration", order: 21, label: settingsLabel, locale: LOCALE_NS, inject: () => ({}) },
          ImportSettingsSection,
        );
      });
    }
