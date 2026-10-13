// dsh-deepseek-turn-cost — 浏览器半边（dsh.client bundle）。
//
// 三个落点（全部由本文件注册，互不重叠）：
//
// 落点一：`sidebar.footer.action`（root 作用域）。它是 `sidebar.settings`（账户区）的前一个兄弟，
//   所以注册到这里天然落在「用户栏上方」。容器宽 100%、高由内容撑开；侧栏折叠时容器退化为
//   `width:auto` 居中，此时 props.wide === false，只渲染一枚 18px 徽标。
//   内容只剩两块：**账户余额** 与 **空闲/高峰时段**（不再有会话费用、逐轮明细、价目版本）。
//
// 落点二：`conversation.composer.dock`（session 作用域，输入框下方居中的信息条）。
//   一行小字「本会话费用 ¥0.0560」，与官方 `mf/stats` 同一视觉层级；standardProps 里带 sessionId。
//
// 落点三：`conversation.chat.assistant-actions`（session 作用域，每轮对话动作行）。
//   动作行的容器是 display:flex，内置项（复制 / 存入记忆 / 开新分支 / 用量·耗时）都没写 CSS order
//   （默认 0），所以本条目在根元素上写 `style={{ order: 2 }}`，视觉上就排到「用量 17M tok」之后。
//   内容：`本轮对话约¥0.0560` + 一个 16px 的「A」按钮，点开在 portal 浮层里做本轮 AI 分析。
//
// 数据：三个落点共用**同一个模块级 store 与同一个轮询器**（逐轮条目可能同时存在几十个，
// 绝不能每个实例各起一个 setInterval）。每条会话作用域条目在挂载时把 standardProps.sessionId
// 写进 store，因此不再需要「会话信标」那一套回写设计。
//
// 数据都来自同一个 Host 插件注册的两条回环 HTTP 路由（同源，直接 fetch 相对路径）：
//   GET  /dsh-deepseek-turn-cost/state?sessionId=<可选>  → 余额 / 逐轮用量 / 峰谷时段快照
//   POST /dsh-deepseek-turn-cost/analyze                 → 单轮 AI 分析（可能跑 30–120 秒）
// 浏览器半边看不到会话事件流，也拿不到账户凭据，所以这些数字只能由 Host 侧算好下发。
//
// 加载方式：由 dsh-client-modules 作为页面里的普通 JS 模块提供给页面，经
// window.__ModuleLoader__.load 的惰性模块表执行（文件里没有任何静态 import）。
// 只 require("react") 与 require("react-dom")（后者仅用于 createPortal），
// 不 import 任何 @deepseek-ai/* 包 —— 所有控件都用 h() 自绘，降低与宿主版本耦合的风险。
window.__ModuleLoader__.load({
  id: "dsh-deepseek-turn-cost",
  factory: (require) => {
    const React = require("react");
    const ReactDOM = require("react-dom");
    const h = React.createElement;
    const Fragment = React.Fragment;
    // 具名取出用到的 hook；文件里没有静态 import，也没有解构 require 之外的依赖。
    const { useState, useEffect, useRef } = React;
    // createPortal 拿不到时退化成行内面板（不阻断功能，只是位置不理想）。
    const createPortal = ReactDOM && typeof ReactDOM.createPortal === "function" ? ReactDOM.createPortal : null;

    /** 语言字典命名空间。 */
    const NS = "deepseekTurnCost";
    /** 条目 id 前缀（各落点自己拼后缀）。 */
    const ENTRY_ID = "deepseek-turn-cost";
    /** 落点一：Settings 旁边的 sidebar footer 动作区（root 作用域）。 */
    const SLOT_SIDEBAR = "sidebar.footer.action";
    /** 落点二：输入框下方信息条（session 作用域，standardProps 带 sessionId）。 */
    const SLOT_DOCK = "conversation.composer.dock";
    /** 落点三：每轮对话的动作行（session 作用域，ownerProps 带 messageId）。 */
    const SLOT_TURN_ACTIONS = "conversation.chat.assistant-actions";
    /** Host 侧两条回环路由。 */
    const ROUTE_STATE = "/dsh-deepseek-turn-cost/state";
    const ROUTE_ANALYZE = "/dsh-deepseek-turn-cost/analyze";
    /** 轮询兜底间隔（毫秒）；响应里带 pollMs 时以响应为准。 */
    const DEFAULT_POLL_MS = 5000;
    /** 数据还没回来时的占位符。 */
    const PLACEHOLDER = "—";
    /**
     * 逐轮条目在动作行里的 CSS order。
     * 动作行是 display:flex，且内置项都没写 order（默认 0），所以写 2 就排到
     * 「用量 xxM tok / 耗时」那一组之后，同时也在「存入记忆 / 开新分支」之后。
     */
    const TURN_ACTION_ORDER = 2;
    /** AI 分析浮层锚点与尺寸。 */
    const POP_MAX_WIDTH = 560;
    const POP_Z_INDEX = 60;

    /* ---------------------------------------------------------------- 字典 */

    const zh = {
      label: "DeepSeek 余额",
      title: "DeepSeek 余额与花费",
      refresh: "刷新",
      refreshTitle: "立即拉取一次余额",
      balanceLabel: "账户余额",
      balanceUnavailable: "余额不可用",
      balanceSignedOut: "未登录",
      balanceLow: "余额不足，可能影响调用",
      balanceLoading: "正在读取…",
      bonusLabel: "赠送",
      sessionCostLabel: "本会话费用",
      recentBadge: "≈",
      recentBadgeTitle: "未锁定到当前对话，显示的是最近有活动的会话",
      turnCostLabel: "本轮对话约{amount}",
      turnAnalyze: "AI 分析本轮对话",
      analysisLoading: "分析中…",
      analysisLoadingHint: "正在分析这一轮的 token 去向，可能需要 30–120 秒，请不要关闭页面。",
      analysisTitle: "AI 分析 · 第 {n} 轮",
      analysisClose: "关闭",
      collapse: "收起",
      analysisFailed: "分析失败",
      analysisRouteLabel: "分析模型",
      analysisDegraded: "思考预算被上限截断，以下是模型的思考内容：",
      errHttp: "请求失败",
      errParse: "响应解析失败",
      errNetwork: "请求出错",
      summaryBalance: "余额",
      summaryPhase: "时段",
    };

    const en = {
      label: "DeepSeek Balance",
      title: "DeepSeek balance & spend",
      refresh: "Refresh",
      refreshTitle: "Fetch balance right now",
      balanceLabel: "Balance",
      balanceUnavailable: "Balance unavailable",
      balanceSignedOut: "Not signed in",
      balanceLow: "Low balance, calls may start failing",
      balanceLoading: "Loading…",
      bonusLabel: "bonus",
      sessionCostLabel: "This session",
      recentBadge: "≈",
      recentBadgeTitle: "Not locked to the current chat — showing the session with the most recent activity",
      turnCostLabel: "This turn ≈ {amount}",
      turnAnalyze: "Analyze this turn with AI",
      analysisLoading: "Analyzing…",
      analysisLoadingHint: "Analyzing where this turn's tokens went. This can take 30–120 seconds; keep this page open.",
      analysisTitle: "AI analysis · turn {n}",
      analysisClose: "Close",
      collapse: "Collapse",
      analysisFailed: "Analysis failed",
      analysisRouteLabel: "Model",
      analysisDegraded: "The thinking budget was cut off by the token limit; showing the model's reasoning:",
      errHttp: "Request failed",
      errParse: "Could not parse the response",
      errNetwork: "Request error",
      summaryBalance: "Balance",
      summaryPhase: "Rate",
    };

    /* ---------------------------------------------------------------- 样式 */

    /*
     * 三段样式各自跟着自己的落点注入（组件根节点内联 <style>），这样即使侧栏卡片没挂载，
     * 信息条与逐轮条目也能独立成style。只引用 --dsw-alias-* 主题令牌（14 个合法令牌之内），
     * 每个令牌都给字面量兜底。
     */

    /** 落点一：侧栏卡片。 */
    const CARD_STYLES = `
.dstc-root{width:100%;box-sizing:border-box;font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#1f2328)}
.dstc-card{width:100%;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#ffffff)}
.dstc-head{display:flex;align-items:center;justify-content:space-between;gap:6px}
.dstc-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}
.dstc-block{display:flex;flex-direction:column;gap:2px;min-width:0}
.dstc-row{display:flex;align-items:center;gap:4px;min-width:0}
.dstc-label{color:var(--dsw-alias-label-secondary,#8a8f98)}
.dstc-amount{font-weight:600;color:var(--dsw-alias-label-primary,#1f2328);font-variant-numeric:tabular-nums}
.dstc-amount-lg{font-size:18px}
.dstc-extra{color:var(--dsw-alias-label-secondary,#9aa0a6)}
.dstc-note{color:var(--dsw-alias-label-secondary,#9aa0a6);word-break:break-word}
.dstc-error{border-left:3px solid var(--dsw-alias-state-error-primary,#d92d20);border-radius:6px;padding:4px 6px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);color:var(--dsw-alias-state-error-primary,#d92d20);word-break:break-word}
.dstc-phase{display:flex;flex-direction:column;gap:0;padding-left:6px;border-left:3px solid transparent;color:var(--dsw-alias-label-secondary,#8a8f98)}
.dstc-phase-main{overflow:hidden;text-overflow:ellipsis}
.dstc-phase-sub{color:var(--dsw-alias-label-secondary,#9aa0a6)}
.dstc-phase.is-peak{border-left-color:var(--dsw-alias-state-warn-primary,#e08a00);color:var(--dsw-alias-state-warn-primary,#e08a00)}
.dstc-phase.is-peak .dstc-phase-main{font-weight:700}
.dstc-phase.is-off{border-left-color:var(--dsw-alias-state-success-primary,#12a150);color:var(--dsw-alias-state-success-primary,#12a150)}
.dstc-btn{display:inline-flex;align-items:center;height:20px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#8a8f98);font:inherit;font-size:11px;line-height:1;cursor:pointer}
.dstc-btn:hover:enabled{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dstc-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}
.dstc-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-secondary,#9aa0a6)}
.dstc-dot.is-peak{background:var(--dsw-alias-state-warn-primary,#e08a00)}
.dstc-dot.is-off{background:var(--dsw-alias-state-success-primary,#12a150)}
.dstc-mini{display:flex;align-items:center;justify-content:center;gap:3px;height:18px;max-width:100%;box-sizing:border-box;padding:0 4px;border-radius:5px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);color:var(--dsw-alias-label-secondary,#8a8f98);font-size:10px;line-height:18px;font-variant-numeric:tabular-nums;cursor:default}
.dstc-mini-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

    /** 落点二：输入框下方信息条里的一行小字（不是块级卡片）。 */
    const DOCK_STYLES = `
.dstc-dock{display:inline-flex;align-items:center;gap:4px;min-width:0;font-size:12px;line-height:1.4;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--dsw-alias-label-secondary,#8a8f98)}
.dstc-dock-label{color:var(--dsw-alias-label-secondary,#8a8f98)}
.dstc-dock-cost{color:var(--dsw-alias-label-primary,#1f2328)}
.dstc-approx{flex:none;padding:0 3px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#f5f6f7);color:var(--dsw-alias-label-secondary,#9aa0a6);cursor:help}
`;

    /** 落点三：逐轮条目 + AI 分析浮层。 */
    const TURN_STYLES = `
.dstc-turn-action{display:inline-flex;align-items:center;gap:8px;min-width:0;font-size:12px;line-height:1;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#8a8f98)}
.dstc-turn-cost{white-space:nowrap;color:var(--dsw-alias-label-secondary,#8a8f98)}
.dstc-abtn{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#8a8f98);font:inherit;font-size:10px;line-height:1;cursor:pointer}
.dstc-abtn:hover:enabled{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dstc-abtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d6bfe);outline-offset:1px}
.dstc-abtn:disabled{opacity:.6;cursor:default}
.dstc-abtn.is-open{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dstc-pop{position:fixed;z-index:${POP_Z_INDEX};display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));border-radius:8px;background:var(--dsw-alias-bg-overlay,#ffffff);box-shadow:0 10px 28px rgba(0,0,0,.18);font-size:12px;line-height:1.5;text-align:left;color:var(--dsw-alias-label-primary,#1f2328)}
.dstc-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dstc-pop-title{font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}
.dstc-pop-tools{display:inline-flex;align-items:center;gap:6px;min-width:0}
.dstc-pop-route{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#9aa0a6)}
.dstc-pop-close{display:inline-flex;align-items:center;height:18px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary,#8a8f98);font:inherit;font-size:11px;line-height:1;cursor:pointer}
.dstc-pop-close:hover{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe)}
.dstc-pop-text{white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary,#1f2328)}
.dstc-pop-loading{color:var(--dsw-alias-label-secondary,#9aa0a6)}
.dstc-pop-error{color:var(--dsw-alias-state-error-primary,#d92d20);word-break:break-word}
.dstc-pop-degraded{margin-bottom:4px;color:var(--dsw-alias-state-warn-primary,#b54708)}
`;

    /* ------------------------------------------------------------ 数值格式化 */

    /** 千分位分组（只处理整数部分，负号与小数不受影响）。 */
    function groupDigits(text) {
      return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    }

    /** 任何输入都收敛成一个有限数字；非数字按 0 处理，避免渲染出 NaN。 */
    function toNumber(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    }

    /** 固定小数位 + 千分位 + tabular-nums 友好的数字文本。 */
    function numberText(value, digits) {
      const d = Number.isFinite(digits) && digits >= 0 ? Math.floor(digits) : 0;
      const parts = toNumber(value).toFixed(d).split(".");
      const head = groupDigits(parts[0]);
      return parts.length > 1 ? `${head}.${parts[1]}` : head;
    }

    /** 金额：符号在前、负号在最前，例如 -¥1.20。 */
    function moneyText(value, symbol, digits) {
      const n = toNumber(value);
      const sign = n < 0 ? "-" : "";
      return `${sign}${symbol || ""}${numberText(Math.abs(n), digits)}`;
    }

    /** 余额一律两位小数；费用小额用四位，≥1 元用两位。 */
    function costText(value, symbol) {
      return moneyText(value, symbol, Math.abs(toNumber(value)) >= 1 ? 2 : 4);
    }

    /** 币种符号；后端会下发 symbol，这里只是缺省兜底。 */
    function symbolOf(currency, fallback) {
      if (currency === "USD") return "$";
      if (currency === "CNY") return "¥";
      return fallback || "¥";
    }

    /** 极简 {n} 插值：不依赖宿主 t() 是否支持参数。 */
    function fmt(t, key, params) {
      let text = String(t(key));
      if (params !== undefined && params !== null) {
        for (const name of Object.keys(params)) {
          text = text.split(`{${name}}`).join(String(params[name]));
        }
      }
      return text;
    }

    /** 槽位标准属性里的会话 id 归一化：只有非空字符串才算数。 */
    function normalizeId(value) {
      return typeof value === "string" && value.length > 0 ? value : "";
    }

    /* ------------------------------------------------------------ 共享 store */

    /*
     * 三个落点共用同一份快照：侧栏卡片只读余额与时段，信息条读本会话费用，
     * 逐轮条目读某一轮的费用。逐轮条目数量随对话轮数增长，所以：
     *   · 只允许有一个轮询器（startPolling 幂等，第一个订阅者开启）；
     *   · 没有订阅者时立刻停掉定时器（stopPolling），不留后台请求；
     *   · 会话作用域条目挂载时用 setSession 声明自己在看哪个会话。
     * 组件侧用 useState(版本号) + useEffect(subscribe) 订阅，不依赖 useSyncExternalStore，
     * 避免绑死宿主 React 版本。
     */
    const store = {
      /** 最近一次成功的 /state 响应。 */
      snapshot: null,
      /** 最近一次失败；成功一次即清空。 */
      error: null,
      /** 当前关注的会话 id（由会话作用域条目写入）。 */
      sessionId: null,
      /** 订阅者集合（三个落点的所有存活实例）。 */
      listeners: new Set(),
      /** 轮询定时器句柄；null 表示没在轮询。 */
      timer: null,
      /** 是否已有一次 /state 在飞：防止慢响应堆叠。 */
      inflight: false,
      /** 轮询间隔（毫秒），以后端下发的 pollMs 为准。 */
      pollMs: DEFAULT_POLL_MS,
      /** 单调递增的版本号，订阅者拿它当 useState 的值。 */
      revision: 0,
    };

    /** 当前快照（渲染期直接读）。 */
    function getSnapshot() {
      return store.snapshot;
    }

    /** 最近一次失败（渲染期直接读）。 */
    function getError() {
      return store.error;
    }

    /** 版本号：每次 notify 自增，订阅者用它触发重渲染。 */
    function getRevision() {
      return store.revision;
    }

    /** 通知所有订阅者；某个订阅者抛异常不能拖垮其它人。 */
    function notify() {
      store.revision += 1;
      for (const listener of store.listeners) {
        try {
          listener();
        } catch (cause) {
          console.warn("[dsh-deepseek-turn-cost] 订阅者回调报错：", cause);
        }
      }
    }

    /** 起轮询（幂等），回调里在页面隐藏时直接跳过。 */
    function startPolling() {
      if (store.timer !== null) return;
      store.timer = setInterval(() => {
        if (typeof document !== "undefined" && document.hidden === true) return;
        void load();
      }, store.pollMs);
    }

    /** 停轮询：没有订阅者时不留任何定时器。 */
    function stopPolling() {
      if (store.timer === null) return;
      clearInterval(store.timer);
      store.timer = null;
    }

    /** 拉一次 /state；已有请求在飞时直接跳过。 */
    async function load() {
      if (store.inflight) return;
      store.inflight = true;
      let restartTimer = false;
      try {
        const body = await fetchState(store.sessionId);
        store.snapshot = body;
        store.error = null;
        const next = Number(body && body.pollMs);
        if (Number.isFinite(next) && next >= 1000 && next !== store.pollMs) {
          store.pollMs = next;
          restartTimer = true;
        }
      } catch (cause) {
        store.error = cause;
      } finally {
        store.inflight = false;
      }
      // 后端改了轮询间隔就按新间隔重建定时器（只在有订阅者时）。
      if (restartTimer && store.timer !== null) {
        stopPolling();
        startPolling();
      }
      notify();
    }

    /** 订阅共享快照；第一个订阅者到来时立刻拉一次并开启轮询。 */
    function subscribe(listener) {
      store.listeners.add(listener);
      if (store.timer === null) {
        startPolling();
        void load();
      }
      return () => {
        store.listeners.delete(listener);
        if (store.listeners.size === 0) stopPolling();
      };
    }

    /** 会话作用域条目声明「我在看哪个会话」；值变化时立刻重拉一次。 */
    function setSession(id) {
      const next = normalizeId(id) || null;
      if (next === store.sessionId) return;
      store.sessionId = next;
      void load();
    }

    /* ---------------------------------------------------------------- 网络 */

    /** 带上错误码的错误，便于组件侧映射到本地化文案。 */
    function requestError(code, detail) {
      const error = new Error(detail === undefined || detail === null ? "" : String(detail));
      error.dsbCode = code;
      return error;
    }

    /** 统一处理「非 200 / 不是 JSON」两种情况。 */
    async function readJson(response) {
      let body = null;
      try {
        body = await response.json();
      } catch {
        throw requestError("parse", response && response.status ? `HTTP ${response.status}` : "");
      }
      if (!response || !response.ok) {
        throw requestError("http", (body && body.error) || (response ? `HTTP ${response.status}` : ""));
      }
      return body;
    }

    /** 拉一次全量快照；没有会话 id 时后端回退到「最近有事件的会话」。 */
    async function fetchState(sessionId) {
      const url = normalizeId(sessionId) ? `${ROUTE_STATE}?sessionId=${encodeURIComponent(sessionId)}` : ROUTE_STATE;
      const response = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      return await readJson(response);
    }

    /**
     * 触发一轮 AI 分析。这条请求可能跑 30–120 秒，所以调用方必须先渲染 loading。
     * 后端契约：无论成败一律 HTTP 200，用 body.ok 区分。
     */
    async function fetchAnalyze(turnNo, sessionId) {
      const payload = { turn: turnNo };
      if (normalizeId(sessionId)) payload.sessionId = sessionId;
      const response = await fetch(ROUTE_ANALYZE, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await readJson(response);
      if (body === null || body.ok !== true) {
        return { ok: false, error: String((body && body.error) || "") };
      }
      return {
        ok: true,
        text: String(body.text || ""),
        model: String((body.route && body.route.model) || ""),
        provider: String((body.route && body.route.provider) || ""),
        degraded: String(body.degraded || ""),
      };
    }

    /** 把内部错误对象转成一行可读文案。 */
    function errorText(error, t) {
      if (error === null || error === undefined) return "";
      const code = error.dsbCode;
      const head = code === "http" ? t("errHttp") : code === "parse" ? t("errParse") : t("errNetwork");
      const detail = String((error && error.message) || "").trim();
      return detail ? `${head}：${detail}` : head;
    }

    /** 组件里统一取本地化函数（apply 会注入，拿不到就退化成 key 本身）。 */
    function binderOf(props) {
      const options = props === undefined || props === null ? {} : props;
      return typeof options.t === "function" ? options.t : (key) => String(key);
    }

    /**
     * 订阅共享快照：返回 [版本号, 数据, 错误] 三件套。
     * 会话作用域条目传入自己的 sessionId：先声明会话（改变时立刻重拉），再订阅；
     * root 作用域的卡片不传，避免把别人写好的会话 id 重置掉。
     */
    function useSharedState(sessionId) {
      const [revision, setRevision] = useState(getRevision());
      const id = normalizeId(sessionId);
      useEffect(() => {
        if (id !== "") setSession(id);
        return subscribe(() => setRevision(getRevision()));
      }, [id]);
      return [revision, getSnapshot(), getError()];
    }

    /* ---------------------------------------------------------- 落点一：侧栏 */

    /**
     * 侧栏底部的余额 / 时段卡片（root 作用域）。
     * @param props.wide - 侧栏是否宽布局；false（折叠态）时只渲染 18px 徽标。
     * @param props.t - 本地化函数（由 apply 闭包注入，不依赖宿主传参）。
     *
     * 这里只有两个 useState（版本号 + 无），声明顺序固定，外部桩渲染依赖它。
     */
    function Card(props) {
      const options = props === undefined || props === null ? {} : props;
      /** 缺省按宽布局渲染：只有明确拿到 wide === false 才折叠。 */
      const wide = options.wide !== false;
      const t = binderOf(props);
      const [, data, error] = useSharedState();
      const phase = (data && data.phase) || null;
      const peak = !!(phase && phase.peak);
      const symbol = (data && data.symbol) || symbolOf(data && data.currency, "¥");
      const balance = (data && data.balance) || null;

      /** 余额主行：只有 status === 'ready' 才显示数字，其余显示明确原因（绝不显示 0）。 */
      const wallets = balance && balance.status === "ready" && Array.isArray(balance.wallets) ? balance.wallets : [];
      const bonusWallets = balance && Array.isArray(balance.bonusWallets) ? balance.bonusWallets : [];
      let balanceMain = PLACEHOLDER;
      let balanceNote = "";
      if (data === null) {
        balanceMain = t("balanceLoading");
      } else if (balance === null) {
        balanceMain = t("balanceUnavailable");
      } else if (balance.status === "ready") {
        balanceMain = wallets.length > 0
          ? moneyText(wallets[0].total, symbolOf(wallets[0].currency, symbol), 2)
          : moneyText(0, symbol, 2);
        if (balance.isAvailable === false) balanceNote = t("balanceLow");
      } else if (balance.status === "signed-out") {
        balanceMain = t("balanceSignedOut");
      } else {
        balanceMain = t("balanceUnavailable");
        balanceNote = String(balance.error || "");
      }
      /** 多钱包 / 赠送余额的补充行。 */
      const extraWallets = [];
      for (const wallet of wallets.slice(1)) {
        extraWallets.push({ key: `w-${wallet.currency}`, text: moneyText(wallet.total, symbolOf(wallet.currency, symbol), 2) });
      }
      for (const wallet of bonusWallets) {
        extraWallets.push({
          key: `b-${wallet.currency}`,
          text: `${t("bonusLabel")} ${moneyText(wallet.total, symbolOf(wallet.currency, symbol), 2)}`,
        });
      }

      /** 折叠态 title 里的纯文本摘要（只有余额与时段）。 */
      const summaryParts = [
        `${t("summaryBalance")} ${balanceMain}${balanceNote ? `（${balanceNote}）` : ""}`,
        phase === null ? "" : `${t("summaryPhase")} ${phase.label}`,
      ].filter((part) => part.length > 0);
      const summary = `${t("title")} · ${summaryParts.join(" · ")}`;

      /* -------------------------------------------------- 折叠态：18px 徽标 */

      if (!wide) {
        const compact = balance !== null && balance.status === "ready" && wallets.length > 0
          ? moneyText(wallets[0].total, symbolOf(wallets[0].currency, symbol), Math.abs(toNumber(wallets[0].total)) < 100 ? 1 : 0)
          : PLACEHOLDER;
        return h(
          "div",
          { className: "dstc-mini", title: summary, "aria-label": summary },
          h("span", { key: "dot", className: `dstc-dot ${peak ? "is-peak" : "is-off"}` }),
          h("span", { key: "text", className: "dstc-mini-text" }, compact),
        );
      }

      /* -------------------------------------------------------------- 主题卡 */

      const blocks = [
        h(
          "div",
          { key: "head", className: "dstc-head" },
          h("span", { key: "title", className: "dstc-title" }, t("title")),
          h(
            "button",
            { key: "refresh", type: "button", className: "dstc-btn", title: t("refreshTitle"), onClick: () => void load() },
            t("refresh"),
          ),
        ),
      ];

      if (error !== null) {
        const text = errorText(error, t);
        blocks.push(h("div", { key: "error", className: "dstc-error", title: text }, text));
      }

      blocks.push(h(
        "div",
        { key: "balance", className: "dstc-block" },
        h("div", { key: "row", className: "dstc-row" }, h("span", { key: "label", className: "dstc-label" }, t("balanceLabel"))),
        h("div", { key: "main", className: "dstc-amount dstc-amount-lg", title: balanceNote || undefined }, balanceMain),
        // 失败原因 / 余额不足提醒：小字可见，鼠标悬停还能看全文。
        balanceNote ? h("div", { key: "note", className: "dstc-note", title: balanceNote }, balanceNote) : null,
        ...extraWallets.map((wallet) => h("div", { key: wallet.key, className: "dstc-extra" }, wallet.text)),
      ));

      // 时段只保留「空闲时段 / 高峰时段」四个字 + 下一档切换时间，倍率与北京时间不再上卡片。
      blocks.push(h(
        "div",
        { key: "phase", className: `dstc-phase ${peak ? "is-peak" : "is-off"}` },
        h("div", { key: "main", className: "dstc-phase-main" }, phase === null ? PLACEHOLDER : String(phase.label || "")),
        h(
          "div",
          { key: "sub", className: "dstc-phase-sub" },
          phase && phase.nextSwitchLabel ? stripApprox(String(phase.nextSwitchLabel)) : "",
        ),
      ));

      return h(
        "div",
        { className: "dstc-root" },
        h("style", { key: "style" }, CARD_STYLES),
        h("div", { key: "card", className: "dstc-card" }, blocks),
      );
    }

    /** 用户明确要求去掉「约 96 分钟后…」里的「约」；后端若已去掉，这里是空操作。 */
    function stripApprox(text) {
      return text.replace(/^约\s*/, "");
    }

    /* ------------------------------------------------- 落点二：信息条会话费用 */

    /**
     * 输入框下方信息条里的「本会话费用」一行小字。
     * @param props.sessionId - 槽位标准属性，当前会话 id。
     * @param props.t - 本地化函数。
     */
    function SessionCostEntry(props) {
      const options = props === undefined || props === null ? {} : props;
      const t = binderOf(props);
      const sessionId = normalizeId(options.sessionId);
      // 订阅共享快照；把本条目看到的会话 id 交给 store（变化时立刻重拉一次）。
      const [, data] = useSharedState(sessionId);

      const session = (data && data.session) || null;
      const symbol = (data && data.symbol) || symbolOf(data && data.currency, "¥");
      /** ≈：没拿到会话 id，或拿到了但后端没匹配上（显示的是最近有活动的会话）。 */
      const approx = session !== null && (sessionId === "" || (data && data.sessionResolved === "recent"));
      const cost = session === null ? PLACEHOLDER : costText(session.totals && session.totals.cost, symbol);

      return h(
        "span",
        { className: "dstc-dock" },
        h("style", { key: "style" }, DOCK_STYLES),
        h("span", { key: "label", className: "dstc-dock-label" }, t("sessionCostLabel")),
        h("span", { key: "cost", className: "dstc-dock-cost" }, cost),
        approx
          ? h("span", { key: "approx", className: "dstc-approx", title: t("recentBadgeTitle") }, t("recentBadge"))
          : null,
      );
    }

    /* --------------------------------------------- 落点三：逐轮费用 + AI 分析 */

    /** 给浮层算一个不会被视口切掉的位置（锚在按钮上方）。 */
    function popPlacement(rect) {
      const viewWidth = typeof window !== "undefined" && Number.isFinite(window.innerWidth) ? window.innerWidth : 1024;
      const viewHeight = typeof window !== "undefined" && Number.isFinite(window.innerHeight) ? window.innerHeight : 768;
      const maxWidth = Math.min(POP_MAX_WIDTH, Math.max(240, Math.round(viewWidth * 0.9)));
      const left = Math.max(8, Math.min(toNumber(rect && rect.left), Math.max(8, viewWidth - maxWidth - 8)));
      const bottom = Math.max(8, viewHeight - toNumber(rect && rect.top) + 8);
      return {
        left: `${left}px`,
        bottom: `${bottom}px`,
        maxWidth: `min(${POP_MAX_WIDTH}px, 90vw)`,
        maxHeight: "50vh",
        overflow: "auto",
      };
    }

    /**
     * 每轮动作行里的「本轮对话约¥x.xxxx」+「A」按钮，点开在本轮下方（portal 浮层）做 AI 分析。
     * @param props.messageId - 槽位 ownerProps，这一轮的 assistant 消息 id。
     * @param props.sessionId - 槽位标准属性，当前会话 id。
     * @param props.t - 本地化函数。
     *
     * 轮次定位：只用 /state 里 turns[].messageIds 认领自己的那一轮（Host 侧下发）；
     * 命中不了就 return null —— 这一轮什么也不渲染，绝不拿别的轮次的金额顶替。
     * useState 顺序固定：版本号 / 面板是否展开 / 锚点矩形 / 分析结果（早退在所有 hook 之后）。
     */
    function TurnCostAction(props) {
      const options = props === undefined || props === null ? {} : props;
      const t = binderOf(props);
      const sessionId = normalizeId(options.sessionId);
      const messageId = normalizeId(options.messageId);

      // 订阅共享快照；会话 id 来自槽位标准属性（变化时立刻重拉一次）。
      const [, data] = useSharedState(sessionId);
      const [open, setOpen] = useState(false);
      const [anchor, setAnchor] = useState(null);
      const [node, setNode] = useState(null);
      const rootRef = useRef(null);
      const panelRef = useRef(null);
      /** 组件是否还挂着：卸载后不再 setState。 */
      const alive = useRef(true);

      useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
        };
      }, []);

      /** Esc 或点面板/按钮之外的地方关闭浮层。 */
      useEffect(() => {
        if (!open) return undefined;
        const onKeyDown = (event) => {
          if (event && (event.key === "Escape" || event.key === "Esc")) setOpen(false);
        };
        const onPointerDown = (event) => {
          const target = event && event.target;
          const panel = panelRef.current;
          const root = rootRef.current;
          if (panel && target && typeof panel.contains === "function" && panel.contains(target)) return;
          if (root && target && typeof root.contains === "function" && root.contains(target)) return;
          setOpen(false);
        };
        document.addEventListener("keydown", onKeyDown);
        document.addEventListener("mousedown", onPointerDown, true);
        return () => {
          document.removeEventListener("keydown", onKeyDown);
          document.removeEventListener("mousedown", onPointerDown, true);
        };
      }, [open]);

      const session = (data && data.session) || null;
      const turns = session && Array.isArray(session.turns) ? session.turns : [];

      /**
       * 用 /state 下发的 turns[].messageIds 认领本轮：
       * 命中不了（宿主进程还是旧的、没下发这个字段，或这个 id 不在任何一轮里）就整条返回 null。
       * 绝不退回 lastTurn / 最后一轮 —— 那会让每一轮都显示同一笔钱，属于假数字。
       */
      let turn = null;
      if (messageId !== "") {
        for (const item of turns) {
          if (item && Array.isArray(item.messageIds) && item.messageIds.indexOf(messageId) >= 0) {
            turn = item;
            break;
          }
        }
      }
      if (turn === null) return null;

      const turnNo = typeof turn.turn === "number" ? turn.turn : null;
      const baseSymbol = (data && data.symbol) || symbolOf(data && data.currency, "¥");
      const symbol = turn.cost && turn.cost.currency ? symbolOf(turn.cost.currency, baseSymbol) : baseSymbol;
      const amount = costText(turn.cost && turn.cost.total, symbol);
      const loading = !!(node && node.status === "loading");
      const opened = open && anchor !== null;

      /** 请求本轮分析结果；写进本条目自己的 state（各条目互不共享）。 */
      const runAnalyze = async (turnNoToUse) => {
        setNode({ status: "loading" });
        try {
          const result = await fetchAnalyze(turnNoToUse, sessionId);
          if (!alive.current) return;
          if (result.ok) {
            setNode({ status: "done", text: result.text, model: result.model, provider: result.provider, degraded: result.degraded });
          } else {
            setNode({ status: "error", error: result.error });
          }
        } catch (cause) {
          if (!alive.current) return;
          setNode({ status: "error", error: errorText(cause, t) });
        }
      };

      /** 点「A」：已展开就收起；没展开就展开，并在没有缓存结果时发起请求。 */
      const toggle = (event) => {
        if (opened) {
          setOpen(false);
          return;
        }
        const target = event && event.currentTarget;
        const rect = target && typeof target.getBoundingClientRect === "function" ? target.getBoundingClientRect() : null;
        setAnchor(rect || null);
        setOpen(true);
        if (turnNo === null) return;
        if (node !== null && node.status !== "error") return;
        void runAnalyze(turnNo);
      };

      /* ------------------------------------------------------------ 浮层内容 */

      let panel = null;
      if (opened) {
        const head = h(
          "div",
          { key: "head", className: "dstc-pop-head" },
          h("span", { key: "title", className: "dstc-pop-title" }, turnNo === null ? t("turnAnalyze") : fmt(t, "analysisTitle", { n: turnNo })),
          h(
            "span",
            { key: "tools", className: "dstc-pop-tools" },
            node && node.model
              ? h(
                "span",
                { key: "route", className: "dstc-pop-route", title: `${node.provider || ""} / ${node.model}` },
                `${t("analysisRouteLabel")}: ${node.model}`,
              )
              : null,
            h("button", { key: "close", type: "button", className: "dstc-pop-close", onClick: () => setOpen(false) }, t("analysisClose")),
          ),
        );
        let body = null;
        if (node === null || node.status === "loading") {
          body = h("div", { key: "body", className: "dstc-pop-loading" }, t("analysisLoadingHint"));
        } else if (node.status === "error") {
          body = h(
            "div",
            { key: "body", className: "dstc-pop-error" },
            `${t("analysisFailed")}${node.error ? `：${node.error}` : ""}`,
          );
        } else {
          // 纯文本渲染（React 会自动转义），绝不 setInnerHTML。
          body = h(
            "div",
            { key: "body" },
            node.degraded ? h("div", { key: "degraded", className: "dstc-pop-degraded" }, t("analysisDegraded")) : null,
            h("div", { key: "text", className: "dstc-pop-text" }, node.text),
          );
        }
        panel = h("div", { key: "panel", ref: panelRef, className: "dstc-pop", style: popPlacement(anchor) }, head, body);
      }

      const portalTarget = typeof document !== "undefined" ? document.body : null;
      const overlay = opened && panel !== null && createPortal !== null && portalTarget !== null
        ? createPortal(panel, portalTarget)
        : opened ? panel : null;

      return h(
        Fragment,
        null,
        h(
          "span",
          { key: "action", ref: rootRef, className: "dstc-turn-action", style: { order: TURN_ACTION_ORDER } },
          h("style", { key: "style" }, TURN_STYLES),
          h("span", { key: "cost", className: "dstc-turn-cost" }, fmt(t, "turnCostLabel", { amount })),
          h(
            "button",
            {
              key: "btn",
              type: "button",
              className: `dstc-abtn${opened ? " is-open" : ""}`,
              disabled: loading || turnNo === null,
              title: loading ? t("analysisLoading") : t("turnAnalyze"),
              "aria-label": t("turnAnalyze"),
              onClick: toggle,
            },
            loading ? "…" : opened ? t("collapse") : "A",
          ),
        ),
        overlay,
      );
    }

    /* ---------------------------------------------------------------- 挂载 */

    /**
     * 注册三个落点：侧栏余额+时段卡片、信息条会话费用、逐轮费用+AI 分析按钮。
     * @param ctx - 客户端 cordis 上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-deepseek-turn-cost: dictionaries");
      const t = ctx.locale.bind(NS);

      // 落点一：账户区上方的余额 / 时段卡片（root 作用域，拿不到 sessionId，也不需要）。
      ctx.slots.inject(SLOT_SIDEBAR, () =>
        ctx.slots.register(
          {
            name: SLOT_SIDEBAR,
            id: ENTRY_ID,
            order: 5,
            label: () => t("label"),
            locale: NS,
          },
          (props) => h(Card, { wide: !!(props && props.wide), t }),
        ),
      );

      // 落点二：输入框下方信息条里的一行小字（session 作用域，standardProps 带 sessionId）。
      ctx.slots.inject(SLOT_DOCK, () =>
        ctx.slots.register(
          {
            name: SLOT_DOCK,
            id: `${ENTRY_ID}.session-cost`,
            order: 10,
            locale: NS,
          },
          (props) => h(SessionCostEntry, { sessionId: props ? props.sessionId : undefined, t }),
        ),
      );

      // 落点三：每轮动作行（session 作用域，ownerProps 带 messageId，standardProps 带 sessionId）。
      ctx.slots.inject(SLOT_TURN_ACTIONS, () =>
        ctx.slots.register(
          {
            name: SLOT_TURN_ACTIONS,
            id: `${ENTRY_ID}.turn-cost`,
            order: 950,
            locale: NS,
          },
          (props) => h(TurnCostAction, {
            messageId: props ? props.messageId : undefined,
            sessionId: props ? props.sessionId : undefined,
            t,
          }),
        ),
      );
    }

    return { inject: ["slots", "locale"], apply };
  },
});
