    // 「导入会话」内容（tab 栏 + 导入/导出/历史三个子视图）：不含遮罩/header/关闭按钮，
    // 供原生右侧栏 tab 复用同一份内容（embedded 模式）。
    // ── 反向导出（DSH 会话 → 外部工具）──────────────────────────────────────────
    // 与导入共用「格式」概念但方向相反：claude / codex / kimi / opencode 写目标工具的原生
    // 转录格式，bundle 是本插件的 interchange 便携包（事件级无损、可再还原成可续聊会话），
    // markdown 是纯文本。
    // codex-native 与 codex 的区别：codex 只产出一个 rollout.jsonl 让用户自己搬进 Codex；
    // codex-native 直接装进本机 Codex 库位（rollout + threads 索引 + 投影迁移），重开 Codex
    // 就能在对应项目里看到这次会话。defDir 与 lib/export-tool.mjs / session-export.mjs 各执行
    // 体的缺省落点一致，只用来做输入框 placeholder——真正的缺省目录永远由宿主侧决定。
    const EXPORT_FORMATS = [
      { id: "codex-native", labelKey: "export.format.codexNative", hint: "export.hint.codexNative", defDir: "~/.codex/sessions", inPlace: true },
      { id: "claude", label: "Claude Code", hint: "target.hint.claude", defDir: "~/.claude/projects" },
      { id: "codex", label: "Codex（文件）", hint: "target.hint.codex", defDir: "~/.dsh/exports" },
      { id: "kimi", label: "Kimi", hint: "target.hint.kimi", defDir: "~/.dsh/exports" },
      { id: "opencode", label: "opencode", hint: "target.hint.opencode", defDir: "~/.dsh/exports" },
      { id: "bundle", labelKey: "export.format.bundle", hint: "export.hint.bundle", defDir: "~/.dsh/exports" },
      { id: "markdown", labelKey: "export.format.markdown", hint: "export.hint.markdown", defDir: "~/.dsh/exports" },
    ];

    /** 导出面板：列出本机全部 DSH 会话（标题取自会话投影缓存，零 I/O），勾选后批量导出成
     *  选定的格式。列表、执行、落盘全部走宿主侧路由（/api-import/export/*），面板只负责
     *  勾选与文案；导出成功给出文件路径并支持一键复制（与 HistoryPanel 的交互习惯一致）。 */
    function ExportPanel() {
      const t = useTranslate();
      const colors = COLORS;
      const style = STYLES;
      const [rows, setRows] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [query, setQuery] = useState("");
      const [withSubagents, setWithSubagents] = useState(false);
      const [picked, setPicked] = useState(() => new Set());
      const [format, setFormat] = useState("bundle");
      const [outDir, setOutDir] = useState("");
      const [busy, setBusy] = useState(false);
      const [report, setReport] = useState(null); // { done: [...], failed: [...] }
      const [codex, setCodex] = useState(null);   // /api-import/export/codex-status 的载荷
      const [projectPath, setProjectPath] = useState(""); // codex-native：装进哪个项目（空 = 会话自己的 cwd）
      // 「选择项目文件夹」：不弹系统对话框（客户端插件拿不到宿主对话框，也不该为一次选择要权限），
      // 直接在面板里列目录逐级点选——比让用户手打 Windows 路径傻瓜得多。
      const [browse, setBrowse] = useState(null); // { path, parent, dirs, project, home }
      const [browseBusy, setBrowseBusy] = useState(false);
      const [browseError, setBrowseError] = useState(null);

      const openBrowse = (startPath) => {
        setBrowseBusy(true);
        setBrowseError(null);
        postJson("/api-import/export/browse", { path: startPath || projectPath || "" }).then((res) => {
          if (!res.ok) { setBrowseError(res.error || t("error.route")); return; }
          setBrowse(res.data);
        }).catch((err) => setBrowseError(errorText(err))).finally(() => setBrowseBusy(false));
      };

      // 列表读取：挂载时一次（与 HistoryPanel 同款；t 每次渲染都是新函数，放进依赖会自激），
      // 之后由 ⟳ 手动刷新。
      const load = () => {
        setLoading(true);
        setError(null);
        postJson("/api-import/export/sessions", {}).then((res) => {
          if (!res.ok) { setError(res.error || t("error.load")); return; }
          const list = res.data && Array.isArray(res.data.sessions) ? res.data.sessions : [];
          setRows(list);
        }).catch((err) => setError(errorText(err))).finally(() => setLoading(false));
      };
      useEffect(() => { load(); }, []);

      // Codex 库位：只在选中 codex-native 时才需要，但状态很便宜（读一行 sqlite + 找 CLI），
      // 挂载时顺手取一次，切换格式不再等网络。
      useEffect(() => {
        postJson("/api-import/export/codex-status", {}).then((res) => {
          if (res.ok && res.data) setCodex(res.data);
        }).catch(() => { /* 面板照常可用，只是不显示项目下拉 */ });
      }, []);

      // 过滤在客户端做：宿主一次给全量（上限 800 行），输入即时响应，不产生扫描请求。
      const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        return rows.filter((r) => {
          if (!withSubagents && r.subagent) return false;
          if (!q) return true;
          return String(r.title || "").toLowerCase().includes(q)
            || String(r.cwd || "").toLowerCase().includes(q)
            || String(r.sessionId || "").toLowerCase().includes(q);
        });
      }, [rows, query, withSubagents]);

      const chosen = useMemo(() => visible.filter((r) => picked.has(r.sessionId)), [visible, picked]);
      const current = EXPORT_FORMATS.find((f) => f.id === format) || EXPORT_FORMATS[0];

      const toggle = (id) => setPicked((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
      });
      const pickAll = () => setPicked((prev) => {
        const next = new Set(prev);
        for (const r of visible) next.add(r.sessionId);
        return next;
      });

      const run = () => {
        if (chosen.length === 0) { setError(t("export.noSelection")); return; }
        setBusy(true);
        setError(null);
        setReport(null);
        const body = { sessionIds: chosen.map((r) => r.sessionId), format };
        if (current.inPlace) {
          // 装库模式：目标项目根优先（多选时全部装进同一个项目），否则各自用自己的 cwd。
          if (projectPath.trim() !== "") body.cwd = projectPath.trim();
        } else if (outDir.trim() !== "") {
          body.outputDir = outDir.trim();
        }
        postJson("/api-import/export/run", body).then((res) => {
          if (!res.ok) { setError(res.error || t("error.route")); return; }
          const done = res.data && Array.isArray(res.data.results) ? res.data.results : [];
          const failed = res.data && Array.isArray(res.data.failures) ? res.data.failures : [];
          setReport({ done, failed });
          showAppToast(failed.length === 0
            ? t("export.done", { n: done.length })
            : t("export.donePartial", { n: done.length, m: failed.length }));
        }).catch((err) => setError(errorText(err))).finally(() => setBusy(false));
      };

      // 复制路径：宿主页面是 http 源，navigator.clipboard 可用；不可用时如实提示手抄，
      // 不静默失败（用户会以为复制成功了）。
      const copyPath = (text) => {
        const clip = typeof navigator !== "undefined" ? navigator.clipboard : null;
        if (!clip || typeof clip.writeText !== "function") { showAppToast(t("export.copyUnsupported")); return; }
        clip.writeText(text).then(() => showAppToast(t("export.copied"))).catch(() => showAppToast(t("export.copyUnsupported")));
      };

      const rowEl = (r) => {
        const on = picked.has(r.sessionId);
        // 目录只显示末段（会话行宽 28px，长 cwd 会挤掉标题）；完整信息经 title 悬停可查。
        const dir = r.cwd ? String(r.cwd).split(/[\\/]/).filter(Boolean).pop() : "";
        return h("div", {
          key: r.sessionId,
          role: "checkbox",
          "aria-checked": on,
          tabIndex: 0,
          title: r.sessionId + (r.cwd ? "\n" + r.cwd : ""),
          onClick: () => toggle(r.sessionId),
          onKeyDown: (e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(r.sessionId); }
          },
          style: { ...style.item, cursor: "pointer", background: on ? colors.hover : "transparent" },
        },
          h("span", { style: { flex: "none", width: "14px", color: colors.accent, fontSize: "12px", lineHeight: "18px" } }, on ? "✓" : ""),
          h("span", { style: { ...style.itemTitle, flex: "1", minWidth: 0, color: on ? colors.text : colors.dim } }, r.title || t("export.untitled")),
          r.subagent && h("span", { style: { flex: "none", marginLeft: "4px", fontSize: "11px", color: colors.dimmer } }, t("export.subagentTag")),
          dir !== "" && h("span", { style: { ...style.rowTime, flex: "none", maxWidth: "96px", marginLeft: "6px", overflow: "hidden", textOverflow: "ellipsis" } }, dir),
          h("span", { style: style.rowTime }, relTime(r.createdAt, t)));
      };

      const chip = (f) => h("button", {
        key: f.id,
        type: "button",
        disabled: busy,
        onClick: () => { setFormat(f.id); setReport(null); },
        style: {
          padding: "3px 10px", fontSize: "12px", lineHeight: "18px", borderRadius: "999px",
          cursor: busy ? "default" : "pointer",
          border: "1px solid " + (format === f.id ? colors.accent : colors.border),
          background: format === f.id ? colors.accent : "transparent",
          color: format === f.id ? colors.accentForeground : colors.dim,
        },
      }, f.labelKey ? t(f.labelKey) : f.label);

      const reportLine = (r) => {
        // codex-native 的「文件路径」是 rollout 落点，用户真正关心的是「装进了哪个项目」。
        const tail = r.mode === "codex-native"
          ? (r.project ? t("export.project.installed", { name: r.project.name }) : t("export.project.outside"))
          : null;
        // 装库三步里最后一步（Codex 自己投影）可能因 CLI 缺失或版本差异失败；如实提示，别假装成功。
        const migration = r.mode === "codex-native" ? r.migration || null : null;
        const warn = !migration
          ? null
          : (migration.skipped
            ? t("export.project.migrateSkipped")
            : (migration.ok === false ? t("export.project.migrateFailed") : null));
        // 交接包：告诉用户完整历史落在哪、迁移副本带过去多少——这是「能显示但发不出消息」
        // 那次修复的核心产物，用户需要能核对，也需要知道去哪 grep 细节。
        const handoff = r.handoff || null;
        const handoffTip = !handoff
          ? null
          : (handoff.error
            ? t("export.handoff.error", { error: handoff.error })
            : [
              t("export.handoff.archived", { dir: handoff.archiveRelDir || handoff.archiveDir || "" }),
              t("export.handoff.copy", { handoff: handoff.handoffChars || 0, turns: handoff.recentTurns || 0 }),
              handoff.fitted === true && handoff.outputLimit !== undefined
                ? t("export.handoff.fitted", { output: handoff.outputLimit, args: handoff.argumentLimit })
                : null,
            ].filter(Boolean).join("\n"));
        const tip = [r.filePath, tail, warn, handoffTip].filter(Boolean).join("\n");
        return h("div", { key: "done:" + r.sessionId + ":" + r.filePath, style: { display: "flex", flexDirection: "column", gap: "1px" } },
          h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
            h("span", {
              style: { flex: "1", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.text },
              title: tip,
            }, "✓ " + (r.title || r.sessionId) + (tail ? " · " + tail : "") + (warn ? " · " + warn : "")),
            h("button", { type: "button", style: style.pageBtn, onClick: () => copyPath(r.filePath) }, t("export.copy"))),
          handoff && handoff.error
            ? h("div", { style: { fontSize: "11px", color: colors.warn, paddingLeft: "14px", wordBreak: "break-word" } },
              "⚠ " + t("export.handoff.error", { error: handoff.error }))
            : (handoff
              ? h("div", {
                style: { fontSize: "11px", color: colors.dimmer, paddingLeft: "14px", wordBreak: "break-word" },
                title: handoff.archiveDir || "",
              }, t("export.handoff.copy", { handoff: handoff.handoffChars || 0, turns: handoff.recentTurns || 0 })
                + (handoff.archiveRelDir ? " · " + handoff.archiveRelDir : ""))
              : null));
      };

      return h("div", { style: { display: "flex", flexDirection: "column", flex: "1", minHeight: 0 } },
        h("div", { style: style.searchRow },
          h("input", {
            style: style.searchInput,
            value: query,
            spellCheck: false,
            placeholder: t("export.searchPlaceholder"),
            onChange: (e) => setQuery(e.target.value),
          }),
          h("button", { type: "button", style: style.toolBtn, onClick: load, disabled: loading, title: t("export.refresh") }, "⟳"),
          h("button", {
            type: "button",
            style: { ...style.toolBtn, opacity: withSubagents ? 1 : 0.66 },
            onClick: () => setWithSubagents((v) => !v),
            title: t("export.withSubagents"),
          }, t("export.withSubagents"))),
        h("div", { style: style.toolbar },
          h("button", { type: "button", style: style.toolBtn, onClick: pickAll, disabled: visible.length === 0 }, t("export.selectAll")),
          h("button", { type: "button", style: style.toolBtn, onClick: () => setPicked(new Set()), disabled: picked.size === 0 }, t("export.clear")),
          h("span", { style: { ...style.rowTime, marginLeft: "auto" } }, t("export.pickedCount", { n: chosen.length }))),
        loading
          ? h("div", { style: style.status }, t("export.loading"))
          : error !== null && report === null
            ? h("div", { style: style.error }, error)
            : visible.length === 0
              ? h("div", { style: style.status }, t("export.empty"))
              : h("div", { style: style.list }, visible.map(rowEl)),
        h("div", {
          style: { flexShrink: 0, borderTop: "1px solid " + colors.border, padding: "8px 12px", display: "flex", flexDirection: "column", gap: "8px" },
        },
          h("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px" } }, EXPORT_FORMATS.map(chip)),
          h("div", { style: { fontSize: "12px", lineHeight: 1.5, color: colors.dimmer } }, t(current.hint)),
          // codex-native：装进本机 Codex 库位，所以「输出目录」没有意义，换成「装进哪个项目」。
          current.inPlace
            ? h("div", { style: { display: "flex", flexDirection: "column", gap: "4px" } },
              h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
                h("span", { style: { ...style.rowTime, flex: "none" } }, t("export.project.label")),
                h("select", {
                  style: { ...style.searchInput, flex: "1", cursor: "pointer" },
                  value: projectPath,
                  onChange: (e) => { setProjectPath(e.target.value); setBrowse(null); },
                },
                  h("option", { value: "" }, t("export.project.auto")),
                  (codex && Array.isArray(codex.projects) ? codex.projects : []).map((p) =>
                    h("option", { key: p.id, value: p.path }, p.name + " · " + p.path))),
                h("button", {
                  type: "button",
                  style: { ...style.toolBtn, flex: "none" },
                  disabled: browseBusy,
                  title: t("export.browse.open"),
                  onClick: () => (browse ? setBrowse(null) : openBrowse(projectPath)),
                }, browse ? t("export.browse.close") : t("export.browse.open")),
                h("button", {
                  type: "button",
                  style: { ...style.primaryBtn, flex: "none", opacity: busy || chosen.length === 0 ? 0.5 : 1 },
                  disabled: busy || chosen.length === 0,
                  onClick: run,
                }, busy ? t("export.running") : t("export.run", { n: chosen.length }))),
              // 目录浏览器：当前路径 + 上一级 + 子目录列表 + 「装进这里」。选中即写进 projectPath，
              // 之后与下拉框是同一个值（手输与点选不分叉）。
              browse !== null && h("div", {
                style: { border: "1px solid " + colors.border, borderRadius: "8px", padding: "6px", display: "flex", flexDirection: "column", gap: "4px" },
              },
                h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
                  h("span", { style: { ...style.rowTime, flex: "1", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: colors.dim }, title: browse.path }, browse.path),
                  browse.parent && h("button", {
                    type: "button", style: style.pageBtn,
                    onClick: () => openBrowse(browse.parent),
                  }, t("export.browse.up")),
                  h("button", {
                    type: "button", style: style.pageBtn,
                    onClick: () => { setProjectPath(browse.path); setBrowse(null); },
                  }, t("export.browse.pick"))),
                browse.project
                  ? h("div", { style: { fontSize: "11px", color: colors.success } }, t("export.browse.matched", { name: browse.project.name }))
                  : h("div", { style: { fontSize: "11px", color: colors.dimmer } }, t("export.browse.noMatch")),
                h("div", { style: { maxHeight: "132px", overflowY: "auto", display: "flex", flexDirection: "column" } },
                  browse.dirs.length === 0
                    ? h("div", { style: { ...style.rowTime, padding: "2px 4px" } }, t("export.browse.empty"))
                    : browse.dirs.map((d) => h("button", {
                      key: d.path,
                      type: "button",
                      title: d.path,
                      onClick: () => openBrowse(d.path),
                      style: {
                        display: "block", width: "100%", textAlign: "left", padding: "2px 6px",
                        fontSize: "12px", lineHeight: "18px", borderRadius: "6px", cursor: "pointer",
                        border: "none", background: "transparent", color: colors.text,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      },
                    }, d.name))),
                browseError !== null && h("div", { style: { fontSize: "11px", color: colors.error } }, browseError)),
              codex && codex.available === false
                && h("div", { style: { fontSize: "12px", lineHeight: 1.5, color: colors.warn } },
                  t("export.project.noCodex", { home: (codex && codex.codexHome) || "~/.codex" })),
              codex && codex.available === true && codex.cli === null
                && h("div", { style: { fontSize: "12px", lineHeight: 1.5, color: colors.warn } }, t("export.project.noCli")),
              codex && codex.available === true
                && h("div", { style: { fontSize: "11px", lineHeight: 1.5, color: colors.dimmer } },
                  t("export.project.footnote", { home: codex.codexHome })))
            : h("div", { style: { display: "flex", gap: "6px", alignItems: "center" } },
              h("input", {
                style: { ...style.searchInput, flex: "1" },
                value: outDir,
                spellCheck: false,
                placeholder: t("export.outDirPlaceholder", { dir: current.defDir }),
                onChange: (e) => setOutDir(e.target.value),
              }),
              h("button", {
                type: "button",
                style: { ...style.primaryBtn, flex: "none", opacity: busy || chosen.length === 0 ? 0.5 : 1 },
                disabled: busy || chosen.length === 0,
                onClick: run,
              }, busy ? t("export.running") : t("export.run", { n: chosen.length })))),
        report !== null && h("div", {
          style: { flexShrink: 0, maxHeight: "170px", overflowY: "auto", borderTop: "1px solid " + colors.border, padding: "6px 12px", fontSize: "12px", lineHeight: 1.6 },
        },
          report.done.map(reportLine),
          report.failed.map((f) => h("div", { key: "failed:" + f.sessionId, style: { color: colors.error, wordBreak: "break-word" } },
            "✗ " + f.sessionId + "：" + f.error))),
        error !== null && report !== null
          && h("div", { style: { flexShrink: 0, padding: "0 12px 8px", fontSize: "12px", color: colors.error } }, error));
    }

    function ImportTabContent(props) {
      const t = useTranslate();
      const colors = COLORS;
      // page 形态给主区整页用（panel-page.js）：标签按内容宽度排、不三等分撑满整行——
      // 右侧栏只有 380px 上下，三等分是对的；整页 1000px 宽时三等分会让每个标签有
      // 300px 的空旷点击区。
      const page = !!(props && props.page);
      const [tab, setTab] = useState("import");
      const tabBtn = (id, label) => h("button", {
        type: "button",
        onClick: () => setTab(id),
        style: {
          flex: page ? "0 0 auto" : "1",
          padding: page ? "7px 14px" : "8px 0",
          border: "none", cursor: "pointer", fontSize: "13px", fontWeight: 600,
          background: tab === id ? colors.field : "transparent",
          color: tab === id ? colors.text : colors.dim,
          borderRadius: page ? "8px 8px 0 0" : undefined,
          borderBottom: tab === id ? "2px solid " + colors.accent : "2px solid transparent",
        },
      }, label);
      return h(React.Fragment, null,
        h("div", {
          style: {
            display: "flex", flexShrink: 0, borderBottom: "1px solid " + colors.border,
            gap: page ? "2px" : undefined,
          },
        },
          tabBtn("import", t("tab.import")),
          tabBtn("export", t("tab.export")),
          tabBtn("history", t("tab.history"))),
        tab === "import"
          ? h(React.Fragment, null,
            h(FileImportPanel, null),
            h(DiscoveryPanel, null))
          : tab === "export"
            ? h(ExportPanel, null)
            : h(HistoryPanel, null));
    }

    /** 原生右侧栏「导入会话」tab 面板主体（sidebar.right.pane.tab 槽，session 作用域、
     *  keyed by 类型 id）：全高容器内嵌 ImportTabContent（embedded 内容自带滚动与配色）。
     *  面板的标题与关闭由右侧栏 tab 条自己呈现（注册表 title 文本 + strip ✕），组件
     *  不需要再画一个头。 */
    function SidebarImportTab() {
      return h("div", {
        style: { display: "flex", flexDirection: "column", height: "100%", boxSizing: "border-box" },
      },
        h(ImportTabContent, null));
    }

    /** 导入历史面板：读取 imports.json 展平列表，支持单条/全部删除 */
    function HistoryPanel() {
      const t = useTranslate();
      const colors = COLORS;
      const style = STYLES;
      const [entries, setEntries] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [busy, setBusy] = useState(false);
      const [note, setNote] = useState(null);
      const [confirm, setConfirm] = useState(null); // { kind:'all'|'one', sessionId?, count? }

      const load = () => {
        setLoading(true);
        setError(null);
        postJson("/api-import/history", {})
          .then((r) => {
            if (r.ok) {
              setEntries(Array.isArray(r.data.entries) ? r.data.entries : []);
              setError(null);
            } else {
              setError(r.error || t("error.load"));
            }
          })
          .catch((err) => setError(errorText(err)))
          .finally(() => setLoading(false));
      };
      useEffect(() => { load(); }, []);

      // 三个动作（删除导入 / 清理空工作区 / 清理上传暂存）同一套收尾：置忙、清掉上一次的
      // 提示与错误 → 请求 → 成功由 onDone 给一行提示 / 失败亮错误 → 解除忙碌并关掉确认框
      //（确认框只由 purge 与 staging 打开；cleanup 不经确认，关一个本就没开的框是空操作）。
      const runAction = async (path, body, onDone) => {
        setBusy(true);
        setNote(null);
        setError(null);
        try {
          const r = await postJson(path, body);
          if (r.ok) onDone(r.data);
          else setError(r.error || t("error.route"));
        } catch (err) {
          setError(errorText(err));
        } finally {
          setBusy(false);
          setConfirm(null);
        }
      };
      const runPurge = (body) => runAction("/api-import/purge", { confirm: true, ...body }, (data) => {
        const r = data.result || {};
        setNote(t("history.purge.done", { deleted: r.deleted || 0, failed: r.failed || 0 }));
        load();
      });
      // 清理空工作区：只删本插件建过且已无成员的工作区登记（专用导入工作区 + 旧实现为
      // 源目录误建的空工作区），目录与会话日志保留。删的是侧栏里点不动的空分组。
      const runCleanup = () => runAction("/api-import/workspaces/cleanup", {}, (data) => {
        setNote(t("history.cleanup.done", { n: data.count || 0 }));
      });
      // 清理上传暂存：删掉**未被 imports registry 引用**的上传件（含全部未完成上传）。
      // 被引用的暂存件是重导语义的源键（源增长 → 增量续写依赖文件仍在），一律保留。
      const runStagingCleanup = () => runAction("/api-import/uploads", { mode: "cleanup", confirm: true }, (data) => {
        setNote(t("history.staging.done", { removed: data.removed || 0, kept: data.kept || 0 }));
      });

      const confirmDialog = confirm && h("div", {
        style: {
          position: "absolute", inset: 0, background: "rgba(0,0,0,.5)", zIndex: 2,
          display: "flex", alignItems: "center", justifyContent: "center", padding: "16px",
        },
      },
        h("div", {
          style: {
            background: colors.surface, border: "1px solid " + colors.border, borderRadius: "12px",
            padding: "16px", maxWidth: "360px", width: "100%",
          },
        },
          h("div", { style: { fontWeight: 600, marginBottom: "8px" } }, t("history.confirm.title")),
          h("div", { style: { fontSize: "13px", color: colors.dim, marginBottom: "14px", lineHeight: 1.5 } },
            confirm.kind === "staging"
              ? t("history.confirm.staging")
              : confirm.kind === "all"
                ? t("history.confirm.all", { n: confirm.count || 0 })
                : t("history.confirm.one", { id: confirm.sessionId || "" })),
          h("div", { style: { display: "flex", gap: "8px", justifyContent: "flex-end" } },
            h("button", {
              style: style.toolBtn, disabled: busy,
              onClick: () => setConfirm(null),
            }, t("history.confirm.cancel")),
            h("button", {
              style: { ...style.primaryBtn, flex: "none", width: "auto", padding: "6px 14px" },
              disabled: busy,
              onClick: () => (confirm.kind === "staging"
                ? runStagingCleanup()
                : runPurge(confirm.kind === "all" ? { all: true } : { sessionId: confirm.sessionId })),
            }, t("history.confirm.ok")))));

      const body = h(React.Fragment, null,
        h("div", { style: { ...style.toolbar, justifyContent: "space-between" } },
          h("span", { style: { fontWeight: 600, color: colors.text } }, t("history.title")),
          h("div", { style: { display: "flex", gap: "6px" } },
            h("button", { style: style.toolBtn, onClick: load, disabled: busy || loading }, t("refresh")),
            h("button", {
              style: style.toolBtn,
              disabled: busy || loading,
              title: t("history.cleanup.title"),
              onClick: runCleanup,
            }, t("history.cleanup")),
            h("button", {
              style: style.toolBtn,
              disabled: busy || loading,
              title: t("history.staging.title"),
              onClick: () => setConfirm({ kind: "staging" }),
            }, t("history.staging")),
            h("button", {
              style: { ...style.toolBtn, color: colors.error, borderColor: colors.error },
              disabled: busy || loading || entries.length === 0,
              title: t("history.purgeAll.title"),
              onClick: () => setConfirm({ kind: "all", count: entries.length }),
            }, t("history.purgeAll")))),
        note && h("div", { style: style.result }, note),
        error && h("div", { style: style.error }, error),
        loading && h("div", { style: style.status }, t("history.loading")),
        !loading && !error && entries.length === 0 && h("div", { style: style.status }, t("history.empty")),
        !loading && entries.length > 0 && h("div", { style: { ...style.list, paddingTop: "8px" } },
          entries.map((e) => h("div", {
            key: e.sessionId + "\u0000" + e.sourcePath,
            style: { ...style.historyItem, flexDirection: "column", alignItems: "stretch", gap: "4px" },
          },
            h("div", { style: { fontSize: "13px", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
              e.title || t("noTitle")),
            h("div", { style: { fontSize: "11px", color: colors.dimmer, wordBreak: "break-all" } }, e.sourcePath),
            h("div", { style: style.itemMeta },
              h("span", null, e.sessionId),
              h("span", { title: fmtTime(e.importedAt) }, relTime(e.importedAt, t) || t("timeUnknown")),
              h("span", null, (typeof e.turns === "number" ? e.turns : "—") + " / " + (typeof e.events === "number" ? e.events : "—"))),
            h("button", {
              style: { ...style.toolBtn, alignSelf: "flex-end", color: colors.error, borderColor: colors.error, marginTop: "4px" },
              disabled: busy,
              title: t("history.purgeOne.title"),
              onClick: () => setConfirm({ kind: "one", sessionId: e.sessionId }),
            }, t("history.purgeOne"))))));

      return h("div", { style: { display: "flex", flexDirection: "column", minHeight: 0, flex: 1, position: "relative" } },
        body, confirmDialog);
    }

    /** 可搜索下拉（combobox）：触发器按皮肤里模型选择器的形态重绘——没有边框也没有
     *  输入框外观，只有「品牌标 + 当前项文本 + 细箭头」，hover / 展开时浮出一层背景矩形
     *  （矩形贴着内容，所以按钮不 flex-grow）；前缀文本（来源 / 导入到 / 工作区）留在行里
     *  当标签。弹层是同一套二级弹层口径：12px 圆角容器、30px 行高、6px 行圆角、品牌标 +
     *  名称 + 当前项末尾 ✓，顶部保留搜索框（自动聚焦）。替代原生 <select>：来源 / 目标 /
     *  工作区选项多时既好看也能检索。受控组件：value + onChange；点击外部 / Esc 关闭。 */
    function SearchableSelect({ value, options, onChange, disabled, title, colors, searchPlaceholder, noMatchLabel, searchable = true, triggerLabel }) {
      const style = STYLES;
      const [open, setOpen] = useState(false);
      const [filter, setFilter] = useState("");
      const [hover, setHover] = useState(null);
      const [hot, setHot] = useState(false); // 触发器 hover 态（内联样式没有 :hover）
      const [listMax, setListMax] = useState(260); // 列表可用高度（开弹层时按窗口实测）
      const rootRef = useRef(null);
      const inputRef = useRef(null);
      const popRef = useRef(null);
      useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) { setOpen(false); setFilter(""); } };
        // Esc 在此截断冒泡：面板级 Esc 关闭监听挂在 window 上，不 stopPropagation
        // 会连面板一起关掉（原生 select 弹层吞按键，本组件需自行隔离）。
        const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); setFilter(""); } };
        document.addEventListener("mousedown", onDown);
        document.addEventListener("keydown", onKey);
        // 短菜单（searchable: false）不渲染搜索框，自然也没有需要聚焦的输入
        if (inputRef.current) inputRef.current.focus();
        return () => {
          document.removeEventListener("mousedown", onDown);
          document.removeEventListener("keydown", onKey);
        };
      }, [open]);
      // 弹层高度自适应：列表上限 = 视口底部到弹层顶端的距离，再扣掉弹层自己的头部
      //（搜索行 + 分隔线 + 内外边距 ≈ 46px）与底部留白。锚点在上方、弹层只向下长，
      // 所以这轮测量不受上一次结果影响，不会来回抖。用 layout effect：首帧就是最终高度。
      useLayoutEffect(() => {
        if (!open) return undefined;
        const measure = () => {
          const node = popRef.current;
          if (!node) return;
          const top = node.getBoundingClientRect().top;
          setListMax(Math.max(180, Math.round(window.innerHeight - top - 20 - 46)));
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
      }, [open]);
      const current = options.find((o) => o.value === value);
      // 整份选项都没有品牌标（例如工作区）时不再留 16px 槽位——文字直接贴左边，不被白占
      const hasMarks = options.some((o) => o.mark);
      const needle = filter.trim().toLowerCase();
      const shown = !needle ? options : options.filter((o) =>
        String(o.label).toLowerCase().includes(needle) || String(o.value).toLowerCase().includes(needle)
        || String(o.sub || "").toLowerCase().includes(needle));
      const pick = (v) => { onChange(v); setOpen(false); setFilter(""); };
      const lit = open || (hot && !disabled); // 背景矩形：hover 或展开时出现
      return h("div", { ref: rootRef, style: style.selectRoot, title },
        h("button", {
          type: "button", disabled,
          "aria-haspopup": "listbox", "aria-expanded": open,
          style: {
            ...style.selectTrigger,
            background: lit ? colors.hover : "transparent",
            opacity: disabled ? 0.55 : 1,
            cursor: disabled ? "default" : "pointer",
          },
          onMouseEnter: () => setHot(true),
          onMouseLeave: () => setHot(false),
          onClick: () => { setOpen(!open); setFilter(""); setHover(null); },
        },
          h("span", { style: style.selectValue },
            triggerLabel !== undefined ? triggerLabel : (current ? current.label : ""))),
        open && h("div", { ref: popRef, style: style.selectPopover },
          searchable ? h("div", { style: style.selectSearchRow },
            h("span", { style: style.selectSearchIcon }, h(Icon, { name: "search", size: 13 })),
            h("input", {
              ref: inputRef, value: filter, placeholder: searchPlaceholder,
              onChange: (e) => { setFilter(e.target.value); setHover(null); },
              onKeyDown: (e) => {
                if (e.key === "Enter") {
                  const idx = hover !== null && shown.some((o) => o.value === hover) ? shown.findIndex((o) => o.value === hover) : 0;
                  const target = shown[idx >= 0 ? idx : 0];
                  if (target) pick(target.value);
                } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  if (shown.length === 0) return;
                  const idx = hover !== null ? shown.findIndex((o) => o.value === hover) : -1;
                  const next = e.key === "ArrowDown"
                    ? Math.min(shown.length - 1, idx + 1)
                    : Math.max(0, idx <= 0 ? 0 : idx - 1);
                  setHover(shown[next].value);
                }
              },
              style: style.selectSearchInput,
            })) : null,
          searchable ? h("div", { style: style.selectDivider }) : null,
          h("div", { style: { ...style.selectList, maxHeight: listMax + "px" }, role: "listbox" },
            shown.length === 0 && h("div", { style: style.selectEmpty }, noMatchLabel),
            shown.map((o) => {
              // 来源行画品牌锁标（mark + 字标，整块替换名称文本）；没有官方品牌标、或该下拉
              // 没开锁标（导入目标 / 工作区）的行保持「槽位 + 文本」
              const lockup = o.lockup === true && o.mark ? sourceLogo(o.mark) : null;
              return h("button", {
                key: o.value, type: "button", role: "option", "aria-selected": o.value === value,
                onClick: () => pick(o.value),
                onMouseEnter: () => setHover(o.value),
                onMouseLeave: () => setHover((cur) => (cur === o.value ? null : cur)),
                style: {
                  ...style.selectRow,
                  fontWeight: o.value === value ? 500 : 400,
                  background: hover === o.value ? colors.hover : "transparent",
                },
              },
                lockup
                  ? h(SourceLockup, { id: o.mark, label: o.label })
                  : h(React.Fragment, null,
                    hasMarks
                      ? h("span", { style: style.selectMarkSlot },
                        o.mark ? h(BrandMark, { id: o.mark, size: 16 }) : null)
                      : null,
                    h("span", { style: style.selectRowText }, o.label)),
              o.sub ? h("span", { style: style.selectRowSub, title: o.sub }, o.sub) : null,
              h("span", { style: style.selectCheck },
                o.value === value ? h(Icon, { name: "check", size: 13 }) : null));
            }))));
    }
