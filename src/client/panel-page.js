    // 「会话迁移」整页面板：侧栏图标列表（sidebar.panellist）点进来落地的主区页面
    //（main 槽，keyed 与侧栏条目的 id 相同——宿主按「列表 id → 同名 main key」派发）。
    //
    // 为什么要有它：入口原来挂在 sidebar.footer.action（侧栏最底部、和设置/用户同一排），
    // 既不在导航列表里、也容易被当成账号区的一部分。挪到侧栏图标列表后宿主会把主区切到
    // 同名 main 面板，所以这一页必须存在，否则点图标只会得到一块空白。
    //
    // 页面只是「标题栏 + 同一份 ImportTabContent（page 形态）」：功能与右侧栏 tab 完全
    // 共用，不复制任何逻辑；标题栏右侧留一个「在右侧栏打开」的入口，需要边看对话边导入
    // 时把同一面板开回右栏（openNativeImportTab 每次点击重证 sidebarRight 服务）。
    const PANEL_PAGE_MAX_WIDTH = 1040;

    /** 侧栏图标列表里的一枚入口图标（sidebar.panellist 槽的 ownerProps 只有
     *  { size, active }，宿主自己画按钮与悬停态，这里只负责图形）。 */
    function MigrationPanelIcon(props) {
      const size = typeof props.size === "number" && props.size > 0 ? props.size : 20;
      return h("span", {
        style: {
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          color: props.active ? COLORS.accent : "currentColor",
        },
      }, h(LogoIcon, { size }));
    }

    function MigrationPage() {
      const t = useTranslate();
      const colors = COLORS;
      return h("div", {
        style: {
          display: "flex", flexDirection: "column",
          height: "100%", minHeight: 0, boxSizing: "border-box",
        },
      },
        h("div", {
          style: {
            display: "flex", alignItems: "flex-start", gap: "14px",
            flexShrink: 0, padding: "18px 24px 14px",
            borderBottom: "1px solid " + colors.border,
          },
        },
          h("div", {
            style: {
              flex: "none", width: "38px", height: "38px", borderRadius: "11px",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "color-mix(in srgb, " + colors.accent + " 12%, transparent)",
              color: colors.accent,
            },
          }, h(LogoIcon, { size: 22 })),
          h("div", { style: { flex: "auto", minWidth: 0 } },
            h("div", { style: { fontSize: "16px", fontWeight: 600, lineHeight: "22px", color: colors.text } },
              t("trigger.label")),
            h("div", { style: { marginTop: "2px", fontSize: "12px", lineHeight: "18px", color: colors.dim } },
              t("panel.description"))),
          h("button", {
            type: "button",
            title: t("panel.openSidebar.title"),
            onClick: () => { if (typeof openNativeImportTab === "function") openNativeImportTab(); },
            style: {
              flex: "none", display: "inline-flex", alignItems: "center", gap: "6px",
              height: "30px", padding: "0 12px", borderRadius: "8px", cursor: "pointer",
              border: "1px solid " + colors.border, background: "transparent",
              color: colors.dim, fontFamily: "inherit", fontSize: "12px", whiteSpace: "nowrap",
            },
            onMouseEnter: (e) => {
              e.currentTarget.style.color = colors.text;
              e.currentTarget.style.background = colors.hover;
            },
            onMouseLeave: (e) => {
              e.currentTarget.style.color = colors.dim;
              e.currentTarget.style.background = "transparent";
            },
          }, t("panel.openSidebar"))),
        // 内容列：宽屏下不铺满整条主区（会话行列表拉满 1600px 会很难读），居中限宽。
        h("div", {
          style: {
            flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column",
            width: "100%", maxWidth: PANEL_PAGE_MAX_WIDTH + "px", margin: "0 auto",
            padding: "0 24px", boxSizing: "border-box",
          },
        }, h(ImportTabContent, { page: true })));
    }
