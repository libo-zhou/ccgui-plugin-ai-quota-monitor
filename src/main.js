/**
 * AI Quota and Usage Monitor for CC GUI
 * Tier-1 JS Plugin
 */

export default function activate(ctx) {
  const { createElement: h, useState, useEffect, useCallback, useMemo, useRef, useId } = ctx.react;

  // ── 内部状态与订阅 ──────────────────────────────────────────────────────────
  let cachedData = null;
  const pending = new Map();
  const connections = new Map();
  let probeOpenCode = true;
  let visibleServices = DEFAULT_QUOTA_SERVICES;
  let preferredService = null;
  let config = {};
  let initialized = false;
  let disposed = false;
  let cacheWrite = Promise.resolve();
  let isFetchingUsage = false;
  let autoTimer = null;
  let activeEngine = null;
  const subscribers = new Set();

  function quotaSnapshot() {
    return {
      data: cachedData,
      loading: pending.size > 0,
      pendingIds: [...pending.keys()],
      connectedIds: [...connections.keys()],
      usageLoading: isFetchingUsage,
      activeEngine,
      visibleServices,
      preferredService,
      config,
      initialized,
    };
  }

  function notifySubscribers() {
    const snapshot = quotaSnapshot();
    for (const sub of subscribers) sub(snapshot);
  }

  // ── 格式化工具函数 ──────────────────────────────────────────────────────────
  function normalizeTimestamp(ts) {
    if (!ts) return null;
    if (typeof ts === "number") return isNaN(ts) ? null : ts;
    const parsed = Date.parse(ts);
    return isNaN(parsed) ? null : parsed;
  }

  function formatResetTime(resetsAt) {
    const ts = normalizeTimestamp(resetsAt);
    if (!ts) return "--";
    const diff = ts - Date.now();
    if (diff <= 0) return "即将重置";
    const minutes = Math.floor(diff / (60 * 1000));
    const hours = Math.floor(diff / (3600 * 1000));
    const days = Math.floor(diff / (24 * 3600 * 1000));
    if (days > 0) {
      const remHours = Math.floor((diff % (24 * 3600 * 1000)) / (3600 * 1000));
      return `${days}天${remHours}小时`;
    }
    if (hours > 0) {
      const remMins = Math.floor((diff % (3600 * 1000)) / (60 * 1000));
      return `${hours}小时${remMins}分`;
    }
    return `${Math.max(1, minutes)}分钟`;
  }

  function formatExactDate(resetsAt) {
    const ts = normalizeTimestamp(resetsAt);
    if (!ts) return "--";
    const date = new Date(ts);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${d} ${hh}:${mm}`;
  }
  function formatTimeAgo(ts) {
    if (!ts) return "未更新";
    const diff = Math.floor((Date.now() - Number(ts)) / 1000);
    if (diff < 5) return "刚刚";
    if (diff < 60) return `${diff}秒前`;
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    return `${Math.floor(diff / 3600)}小时前`;
  }

  function formatRefreshTime(ts) {
    if (!ts) return "未更新";
    const date = new Date(Number(ts));
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    const ss = String(date.getSeconds()).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function getStatusTone(remaining, warningThreshold) {
    const threshold = typeof warningThreshold === "number" ? warningThreshold : 20;
    if (remaining <= threshold) return "danger";
    if (remaining <= 50) return "warn";
    return "safe";
  }

  function getToneColor(tone) {
    switch (tone) {
      case "danger":
        return "#dc2626";
      case "warn":
        return "#d97706";
      case "safe":
      default:
        return "#16a34a";
    }
  }

  // ── 官方品牌矢量图标 (OpenAI & Google Gemini) ───────────────────────────────
  const GEMINI_PATH =
    "M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z";

  function GeminiIcon({ size = 12, className, style }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        className,
        style: Object.assign({ flexShrink: 0, display: "inline-block", verticalAlign: "middle" }, style),
      },
      h(
        "defs",
        null,
        h(
          "linearGradient",
          { id: "gqc-gemini-g0", x1: "7", y1: "15.5", x2: "11", y2: "12", gradientUnits: "userSpaceOnUse" },
          h("stop", { stopColor: "#08B962" }),
          h("stop", { offset: "1", stopColor: "#08B962", stopOpacity: "0" })
        ),
        h(
          "linearGradient",
          { id: "gqc-gemini-g1", x1: "8", y1: "5.5", x2: "11.5", y2: "11", gradientUnits: "userSpaceOnUse" },
          h("stop", { stopColor: "#F94543" }),
          h("stop", { offset: "1", stopColor: "#F94543", stopOpacity: "0" })
        ),
        h(
          "linearGradient",
          { id: "gqc-gemini-g2", x1: "3.5", y1: "13.5", x2: "17.5", y2: "12", gradientUnits: "userSpaceOnUse" },
          h("stop", { stopColor: "#FABC12" }),
          h("stop", { offset: "0.46", stopColor: "#FABC12", stopOpacity: "0" })
        )
      ),
      h("path", { d: GEMINI_PATH, fill: "#3186FF" }),
      h("path", { d: GEMINI_PATH, fill: "url(#gqc-gemini-g0)" }),
      h("path", { d: GEMINI_PATH, fill: "url(#gqc-gemini-g1)" }),
      h("path", { d: GEMINI_PATH, fill: "url(#gqc-gemini-g2)" })
    );
  }

  function OpenAiIcon({ size = 12, className, style }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "currentColor",
        className,
        style: Object.assign({ flexShrink: 0, display: "inline-block", verticalAlign: "middle" }, style),
      },
      h("path", {
        fillRule: "evenodd",
        d: "M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z",
      })
    );
  }

  function CodeBuddyIcon({ size = 12, className, style }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        className,
        style: Object.assign({ flexShrink: 0, display: "inline-block", verticalAlign: "middle" }, style),
      },
      h(
        "defs",
        null,
        h(
          "radialGradient",
          {
            id: "gqc-codebuddy-g0",
            cx: "0",
            cy: "0",
            r: "1",
            gradientUnits: "userSpaceOnUse",
            gradientTransform: "matrix(-9.00009 -16 16 -9.00009 21 24.5)",
          },
          h("stop", { stopColor: "#2EA99D" }),
          h("stop", { offset: "1", stopColor: "#6C4DFF" })
        )
      ),
      h("path", {
        d: "M18.821 0H5.18A5.179 5.179 0 000 5.179V18.82A5.179 5.179 0 005.179 24H18.82A5.179 5.179 0 0024 18.821V5.18A5.179 5.179 0 0018.821 0z",
        fill: "url(#gqc-codebuddy-g0)",
      }),
      h("path", {
        d: "M18.777 1.647c.28-.02.536.114.972.51 1.018.926 2.437 2.828 3.318 4.452l.34.631.482.24.11.06v3.638a5.206 5.206 0 00-5.32-1.23c-.491.166-1.021.471-2.08 1.082l-6.09 3.516c-1.057.61-1.586.916-1.975 1.259a5.208 5.208 0 00-1.493 5.572c.165.49.471 1.02 1.082 2.08l.315.543h-3.26c-.685 0-1.34-.135-1.939-.377-.169-.956-.009-1.789.469-2.335.158-.18.164-.189.13-.493a11.846 11.846 0 01-.057-1.711l.02-.444-.667-1.18C2.1 15.622 1.445 14.078 1.192 12.9c-.133-.647-.125-.934.04-1.146.1-.128.427-.261.822-.334.994-.175 3.162-.017 5.575.41l.25.043.551-.487c.915-.81 1.522-1.264 2.641-1.962 1.167-.73 2.484-1.331 3.967-1.807l.476-.152.261-.688c.937-2.471 1.896-4.293 2.58-4.9.235-.21.25-.22.422-.23z",
        fill: "#fff",
      }),
      h("path", {
        d: "M12.139 18.2a1.203 1.203 0 011.642.44l1.296 2.243a1.204 1.204 0 01-2.083 1.203l-1.296-2.243a1.203 1.203 0 01.44-1.644zM18.629 14.452a1.203 1.203 0 011.642.44l1.295 2.244a1.203 1.203 0 11-2.083 1.203l-1.295-2.243a1.203 1.203 0 01.44-1.644z",
        fill: "#fff",
      })
    );
  }

  function RefreshIcon({ spinning, size = 13 }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className: spinning ? "gqc-spin" : undefined,
        style: { flexShrink: 0 },
      },
      h("path", { d: "M21 2v6h-6" }),
      h("path", { d: "M3 12a9 9 0 0 1 15-6.7L21 8" }),
      h("path", { d: "M3 22v-6h6" }),
      h("path", { d: "M21 12a9 9 0 0 1-15 6.7L3 16" })
    );
  }

  function CloseIcon({ size = 13 }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        style: { flexShrink: 0 },
      },
      h("line", { x1: 18, y1: 6, x2: 6, y2: 18 }),
      h("line", { x1: 6, y1: 6, x2: 18, y2: 18 })
    );
  }

  function OmpIcon({ size = 12, className, style }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2.2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className,
        style: Object.assign({ flexShrink: 0, display: "inline-block", verticalAlign: "middle", color: "#3b82f6" }, style),
      },
      h("polyline", { points: "4 17 10 11 4 5" }),
      h("line", { x1: 12, y1: 19, x2: 20, y2: 19 })
    );
  }

  function ClaudeIcon({ size = 12, className, style }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "currentColor",
        className,
        style: Object.assign({ flexShrink: 0, display: "inline-block", verticalAlign: "middle", color: "#d97706" }, style),
      },
      h("path", {
        d: "M13.5 2h-3l-.7 4.8-4.2-2.5-1.5 2.6 4.3 2.5-4.3 2.5 1.5 2.6 4.2-2.5.7 4.8h3l.7-4.8 4.2 2.5 1.5-2.6-4.3-2.5 4.3-2.5-1.5-2.6-4.2 2.5-.7-4.8z",
      })
    );
  }

  /*!
   * OpenCode、Grok、Kimi 和 Claude 图标来自 CC GUI。
   * 智谱图标来自 CC GUI 设置页使用的 @lobehub/icons-static-svg。
   *
   * MIT License
   *
   * Copyright (c) 2026 zhukunpenglinyutong（朱昆鹏）
   * Copyright (c) 2023 LobeHub
   *
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   *
   * The above copyright notice and this permission notice shall be included in all
   * copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
   * SOFTWARE.
   */
  function quotaBrandIcon(paths, fill = "currentColor", fillRule = "evenodd") {
    return function QuotaBrandIcon({ size = 12 }) {
      return h("svg", {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill,
        fillRule,
        "aria-hidden": true,
        style: { flexShrink: 0 },
      }, paths.map((d) => h("path", { key: d, d })));
    };
  }

  const OpenCodeIcon = quotaBrandIcon([
    "M16 6H8v12h8V6zm4 16H4V2h16v20z",
  ]);
  const GrokIcon = quotaBrandIcon([
    "M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815",
  ]);
  const KimiIcon = quotaBrandIcon([
    "M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z",
    "M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z",
  ]);
  const ClaudeSubscriptionIcon = quotaBrandIcon([
    "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z",
  ], "#D97757", "nonzero");
  const GlmIcon = quotaBrandIcon([
    "M11.991 23.503a.24.24 0 00-.244.248.24.24 0 00.244.249.24.24 0 00.245-.249.24.24 0 00-.22-.247l-.025-.001zM9.671 5.365a1.697 1.697 0 011.099 2.132l-.071.172-.016.04-.018.054c-.07.16-.104.32-.104.498-.035.71.47 1.279 1.186 1.314h.366c1.309.053 2.338 1.173 2.286 2.523-.052 1.332-1.152 2.38-2.478 2.327h-.174c-.715.018-1.274.64-1.239 1.368 0 .124.018.23.053.337.209.373.54.658.96.8.75.23 1.517-.125 1.9-.782l.018-.035c.402-.64 1.17-.96 1.92-.711.854.284 1.378 1.226 1.099 2.167a1.661 1.661 0 01-2.077 1.102 1.711 1.711 0 01-.907-.711l-.017-.035c-.2-.323-.463-.58-.851-.711l-.056-.018a1.646 1.646 0 00-1.954.746 1.66 1.66 0 01-1.065.764 1.677 1.677 0 01-1.989-1.279c-.209-.906.332-1.83 1.257-2.043a1.51 1.51 0 01.296-.035h.018c.68-.071 1.151-.622 1.116-1.333a1.307 1.307 0 00-.227-.693 2.515 2.515 0 01-.366-1.403 2.39 2.39 0 01.366-1.208c.14-.195.21-.444.227-.693.018-.71-.506-1.261-1.186-1.332l-.07-.018a1.43 1.43 0 01-.299-.07l-.05-.019a1.7 1.7 0 01-1.047-2.114 1.68 1.68 0 012.094-1.101zm-5.575 10.11c.26-.264.639-.367.994-.27.355.096.633.379.728.74.095.362-.007.748-.267 1.013-.402.41-1.053.41-1.455 0a1.062 1.062 0 010-1.482zm14.845-.294c.359-.09.738.024.992.297.254.274.344.665.237 1.025-.107.36-.396.634-.756.718-.551.128-1.1-.22-1.23-.781a1.05 1.05 0 01.757-1.26zm-.064-4.39c.314.32.49.753.49 1.206 0 .452-.176.886-.49 1.206-.315.32-.74.5-1.185.5-.444 0-.87-.18-1.184-.5a1.727 1.727 0 010-2.412 1.654 1.654 0 012.369 0zm-11.243.163c.364.484.447 1.128.218 1.691a1.665 1.665 0 01-2.188.923c-.855-.36-1.26-1.358-.907-2.228a1.68 1.68 0 011.33-1.038c.593-.08 1.183.169 1.547.652zm11.545-4.221c.368 0 .708.2.892.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.892.524c-.568 0-1.03-.47-1.03-1.048 0-.579.462-1.048 1.03-1.048zm-14.358 0c.368 0 .707.2.891.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.891.524c-.569 0-1.03-.47-1.03-1.048 0-.579.461-1.048 1.03-1.048zm10.031-1.475c.925 0 1.675.764 1.675 1.706s-.75 1.705-1.675 1.705-1.674-.763-1.674-1.705c0-.942.75-1.706 1.674-1.706zm-2.626-.684c.362-.082.653-.356.761-.718a1.062 1.062 0 00-.238-1.028 1.017 1.017 0 00-.996-.294c-.547.14-.881.7-.752 1.257.13.558.675.907 1.225.783zm0 16.876c.359-.087.644-.36.75-.72a1.062 1.062 0 00-.237-1.019 1.018 1.018 0 00-.985-.301 1.037 1.037 0 00-.762.717c-.108.361-.017.754.239 1.028.245.263.606.377.953.305l.043-.01zM17.19 3.5a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64a.631.631 0 00-.628.64c0 .355.28.64.628.64zm-10.38 0a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64a.631.631 0 00-.628.64c0 .355.279.64.628.64zm-5.182 7.852a.631.631 0 00-.628.64c0 .354.28.639.628.639a.63.63 0 00.627-.606l.001-.034a.62.62 0 00-.628-.64zm5.182 9.13a.631.631 0 00-.628.64c0 .355.279.64.628.64a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm10.38.018a.631.631 0 00-.628.64c0 .355.28.64.628.64a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64zm5.182-9.148a.631.631 0 00-.628.64c0 .354.279.639.628.639a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm-.384-4.992a.24.24 0 00.244-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249c0 .142.122.249.244.249zM11.991.497a.24.24 0 00.245-.248A.24.24 0 0011.99 0a.24.24 0 00-.244.249c0 .133.108.236.223.247l.021.001zM2.011 6.36a.24.24 0 00.245-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249.24.24 0 00.244.249zm0 11.263a.24.24 0 00-.243.248.24.24 0 00.244.249.24.24 0 00.244-.249.252.252 0 00-.244-.248zm19.995-.018a.24.24 0 00-.245.248.24.24 0 00.245.25.24.24 0 00.244-.25.252.252 0 00-.244-.248z",
  ], "#3859FF", "nonzero");

  function QuotaIcon({ size = 13, className, style }) {
    return h(
      "svg",
      {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        className,
        style: Object.assign({ flexShrink: 0 }, style),
      },
      h("path", { d: "M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" })
    );
  }

  function formatTokensShort(num) {
    const n = Number(num || 0);
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }

  function formatCostDisplay(cost) {
    const c = Number(cost || 0);
    if (c >= 100) return "$" + c.toFixed(1);
    if (c >= 1) return "$" + c.toFixed(2);
    if (c > 0) return "$" + c.toFixed(3);
    return "$0.00";
  }

  function getProviderColor(name) {
    const n = String(name || "").toUpperCase();
    if (n === "CODEX" || n === "OPENAI") return "#3b82f6";
    if (n === "OMP" || n === "OH-MY-PI") return "#06b6d4";
    if (n === "CODEBUDDY") return "#8b5cf6";
    if (n === "WORKBUDDY") return "#ec4899";
    if (n === "CLAUDE" || n === "ANTHROPIC") return "#f59e0b";
    if (n === "GEMINI" || n === "AGY") return "#10b981";
    return "#6366f1";
  }

  function renderProviderIcon(name, size = 12) {
    const n = String(name || "").toUpperCase();
    if (n === "全部" || n === "ALL") {
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, style: { flexShrink: 0, color: "#e4e4e7" } },
        h("polygon", { points: "12 2 2 7 12 12 22 7 12 2" }),
        h("polyline", { points: "2 17 12 22 22 17" }),
        h("polyline", { points: "2 12 12 17 22 12" })
      );
    }
    if (n === "CODEX" || n === "OPENAI") return h(OpenAiIcon, { size, style: { color: "#3b82f6" } });
    if (n === "OMP" || n === "OH-MY-PI") return h(OmpIcon, { size, style: { color: "#06b6d4" } });
    if (n === "CODEBUDDY") return h(CodeBuddyIcon, { size });
    if (n === "WORKBUDDY") return h(CodeBuddyIcon, { size, style: { filter: "hue-rotate(60deg)" } });
    if (n === "CLAUDE" || n === "ANTHROPIC") return h(ClaudeIcon, { size, style: { color: "#f59e0b" } });
    if (n === "GEMINI" || n === "AGY") return h(GeminiIcon, { size });
    return h("span", { style: { fontWeight: 700, fontSize: "11px", color: "#8b5cf6" } }, "●");
  }

  // ── Gemini (Antigravity) 抓取与解析 ──────────────────────────────────────────
  function safeParseJson(raw) {
    if (!raw || typeof raw !== "string") return null;
    const trimmed = raw.trim();
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        try {
          return JSON.parse(trimmed.slice(start, end + 1));
        } catch (_) {}
      }
      return null;
    }
  }

  // 通过 Antigravity CLI (agy) 查询配额
  async function fetchViaAgy() {
    const res = await ctx.bridge.invoke("plugin_exec_run", {
      bin: "agy",
      args: ["--output-format", "json", "-p", "/usage"],
      // 配额查询不需要触发 agy 的后台更新进程。
      env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      timeoutMs: 25000,
    });

    if (res.code !== 0) {
      throw new Error(`agy 退出码 ${res.code}${res.stderr ? `: ${res.stderr.trim()}` : ""}`);
    }

    const json = safeParseJson(res.stdout);
    if (!json || json.status === "ERROR") {
      throw new Error(json?.error || json?.response || "agy 返回空数据或错误状态");
    }

    const command = json.command || {};
    const data = command.data || {};
    const groups = data.groups || [];

    const allBuckets = [];
    for (const group of groups) {
      if (Array.isArray(group.buckets)) {
        allBuckets.push(...group.buckets);
      }
    }

    if (allBuckets.length === 0) {
      throw new Error("agy 配额数据中未找到限额分组");
    }

    const gWeekly = allBuckets.find((b) => b.id && b.id.includes("gemini-weekly"));
    const g5h = allBuckets.find((b) => b.id && b.id.includes("gemini-5h"));
    const p3Weekly = allBuckets.find((b) => b.id && b.id.includes("3p-weekly"));
    const p35h = allBuckets.find((b) => b.id && b.id.includes("3p-5h"));

    function parseBucket(bucket) {
      if (!bucket) return null;
      let remaining = 100;
      if (typeof bucket.remaining_fraction === "number") {
        remaining = bucket.remaining_fraction * 100;
      } else if (typeof bucket.remaining === "number") {
        remaining = bucket.remaining;
      }
      remaining = Math.max(0, Math.min(100, Math.round(remaining * 10) / 10));
      const used = Math.round((100 - remaining) * 10) / 10;

      let resetsAt = null;
      const rawReset = bucket.reset_time || bucket.resetsAt;
      if (rawReset) {
        if (typeof rawReset === "number") {
          resetsAt = rawReset;
        } else {
          const parsed = Date.parse(rawReset);
          if (!isNaN(parsed)) resetsAt = parsed;
        }
      }

      return {
        remaining,
        used,
        resetsAt,
      };
    }

    let email = "";
    try {
      const emailRes = await ctx.bridge.invoke("plugin_exec_run", {
        bin: "node",
        args: [
          "-e",
          'const fs=require("fs"),path=require("path"),os=require("os");try{const p=path.join(os.homedir(),".gemini","antigravity-cli","cli.log");const s=fs.readFileSync(p,"utf8");const m=s.match(/email=([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,})/);if(m)console.log(m[1]);}catch(_){}',
        ],
        timeoutMs: 5000,
      });
      if (emailRes && emailRes.code === 0 && emailRes.stdout && emailRes.stdout.trim()) {
        email = emailRes.stdout.trim();
      }
    } catch (_) {}

    return {
      source: "agy",
      email,
      projectId: "",
      weekly: parseBucket(gWeekly),
      h5: parseBucket(g5h),
      p3Weekly: parseBucket(p3Weekly),
      p35h: parseBucket(p35h),
      fetchedAt: Date.now(),
    };
  }

  // 通过 OMP CLI 查询配额 (兼容回退)
  async function fetchViaOmp() {
    const res = await ctx.bridge.invoke("plugin_exec_run", {
      bin: "omp",
      args: ["usage", "--provider", "google-antigravity", "--json"],
      timeoutMs: 25000,
    });

    if (res.code !== 0) {
      throw new Error(`omp 退出码 ${res.code}${res.stderr ? `: ${res.stderr.trim()}` : ""}`);
    }

    const json = safeParseJson(res.stdout);
    if (!json) throw new Error("omp 输出不是有效 JSON");

    const reports = json.reports || [];
    const agy = reports.find((r) => r.provider === "google-antigravity") || reports[0];
    if (!agy) throw new Error("未找到 Antigravity 报告");

    const limits = agy.limits || [];
    const meta = agy.metadata || {};

    const gWeekly = limits.find((l) => l.id && l.id.includes("gemini-weekly"));
    const g5h = limits.find((l) => l.id && l.id.includes("gemini-5h"));
    const p3Weekly = limits.find((l) => l.id && l.id.includes("3p-weekly"));
    const p35h = limits.find((l) => l.id && l.id.includes("3p-5h"));

    function parseItem(item) {
      if (!item) return null;
      const amount = item.amount || {};
      const window = item.window || {};
      const remaining = typeof amount.remaining === "number" ? amount.remaining : 100;
      const used = typeof amount.used === "number" ? amount.used : (100 - remaining);
      let resetsAt = null;
      const rawReset = window.resetsAt;
      if (rawReset) {
        if (typeof rawReset === "number") {
          resetsAt = rawReset;
        } else {
          const parsed = Date.parse(rawReset);
          if (!isNaN(parsed)) resetsAt = parsed;
        }
      }
      return {
        remaining: Math.round(remaining * 10) / 10,
        used: Math.round(used * 10) / 10,
        resetsAt,
      };
    }

    return {
      source: "omp",
      email: meta.email || "",
      projectId: meta.projectId || "",
      weekly: parseItem(gWeekly),
      h5: parseItem(g5h),
      p3Weekly: parseItem(p3Weekly),
      p35h: parseItem(p35h),
      fetchedAt: agy.fetchedAt || Date.now(),
    };
  }

  // 统一入口：智能自动探测（优先 Antigravity CLI，失败自动回退 Oh-My-Pi）
  async function fetchGeminiQuota() {
    let agyErr = null;
    try {
      return await fetchViaAgy();
    } catch (e) {
      agyErr = e.message || String(e);
    }

    try {
      return await fetchViaOmp();
    } catch (e) {
      const ompErr = e.message || String(e);
      return { error: `Antigravity CLI: ${agyErr}；omp: ${ompErr}` };
    }
  }

  // ── Codex (ChatGPT) 抓取与解析 ─────────────────────────────────────────────
  async function fetchCodexQuota() {
    const nodeInlineCode = 'const fs=require("fs"),path=require("path"),os=require("os");try{const p=path.join(os.homedir(),".codex","auth.json");if(!fs.existsSync(p)){console.log(JSON.stringify({error:"not_found"}));process.exit(0);}const auth=JSON.parse(fs.readFileSync(p,"utf8")),token=auth.tokens&&auth.tokens.access_token;if(!token){console.log(JSON.stringify({error:"no_token"}));process.exit(0);}console.log(JSON.stringify({token}));}catch(e){console.log(JSON.stringify({error:e.message}));}';

    try {
      const res = await ctx.bridge.invoke("plugin_exec_run", {
        bin: "node",
        args: ["-e", nodeInlineCode],
        timeoutMs: 25000,
      });

      if (res.code !== 0) {
        return { error: `Node 退出码 ${res.code}` };
      }

      const credentials = JSON.parse(res.stdout);
      if (credentials.error) {
        return { error: credentials.error === "not_found" ? "未登录 Codex" : credentials.error };
      }

      if (typeof credentials.token !== "string" || !credentials.token) {
        return { error: "Codex 登录凭证中没有访问令牌" };
      }

      const response = await ctx.bridge.invoke("plugin_http_request", {
        method: "GET",
        url: "https://chatgpt.com/backend-api/wham/usage",
        headers: {
          Authorization: `Bearer ${credentials.token}`,
          "User-Agent": "Codex/1.0.0",
        },
      });
      if (response.status !== 200) {
        return { error: `http_${response.status}` };
      }

      const json = JSON.parse(response.body);

      const rateLimit = json.rate_limit || {};
      const primary = rateLimit.primary_window || {};
      const secondary = rateLimit.secondary_window || {};
      const resetCredits = json.rate_limit_reset_credits || {};

      const h5Used = typeof primary.used_percent === "number" ? primary.used_percent : 0;
      const h5Remaining = Math.max(0, 100 - h5Used);
      let h5ResetsAt = primary.reset_at;
      if (h5ResetsAt && h5ResetsAt < 1e12) h5ResetsAt *= 1000;

      const wUsed = typeof secondary.used_percent === "number" ? secondary.used_percent : 0;
      const wRemaining = Math.max(0, 100 - wUsed);
      let wResetsAt = secondary.reset_at;
      if (wResetsAt && wResetsAt < 1e12) wResetsAt *= 1000;

      return {
        email: json.email || "",
        planType: (json.plan_type || "Codex").toUpperCase(),
        resetCredits: resetCredits.available_count || 0,
        weekly: {
          used: wUsed,
          remaining: wRemaining,
          resetsAt: wResetsAt,
        },
        h5: {
          used: h5Used,
          remaining: h5Remaining,
          resetsAt: h5ResetsAt,
        },
        fetchedAt: Date.now(),
      };
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }

  // ── CodeBuddy (Tencent Copilot) 抓取与解析 ──────────────────────────────────
  async function fetchCodeBuddyQuota() {
    const nodeInlineCode = 'const fs=require("fs"),path=require("path"),os=require("os"),https=require("https");(async function(){try{const base=process.platform==="win32"?(process.env.LOCALAPPDATA||path.join(os.homedir(),"AppData","Local")):process.platform==="darwin"?path.join(os.homedir(),"Library","Application Support"):(process.env.XDG_DATA_HOME||path.join(os.homedir(),".local","share"));const authFile=path.join(base,"CodeBuddyExtension","Data","Public","auth","Tencent-Cloud.coding-copilot.info");if(!fs.existsSync(authFile)){console.log(JSON.stringify({error:"未找到 CodeBuddy 登录文件，请先在 CodeBuddy 登录。"}));return;}const raw=fs.readFileSync(authFile,"utf8");let d;try{d=JSON.parse(raw);}catch(_){console.log(JSON.stringify({error:"CodeBuddy 登录文件无法解析，请重新登录。"}));return;}const token=d&&d.auth&&(typeof d.auth.accessToken==="string"?d.auth.accessToken:d.auth.accessToken&&d.auth.accessToken.token);if(typeof token!=="string"||!token){console.log(JSON.stringify({error:"CodeBuddy 登录文件中没有访问令牌，请重新登录。"}));return;}const acc=d.account||{};const cred={token,uid:acc.uid||"",enterpriseId:acc.enterpriseId||"",enterpriseName:acc.enterpriseName||"",userName:acc.enterpriseUserName||acc.displayName||acc.nickname||"",accountType:acc.type||"",domain:(d.auth&&d.auth.domain)||"www.codebuddy.cn"};function requestPost(urlPath,body){return new Promise((resolve,reject)=>{const data=JSON.stringify(body||{});const req=https.request({hostname:"copilot.tencent.com",path:urlPath,method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+cred.token,"X-User-Id":cred.uid,"X-Enterprise-Id":cred.enterpriseId,"X-Tenant-Id":cred.enterpriseId,"X-Domain":cred.domain,"X-Product":"SaaS","X-IDE-Name":"CodeBuddyIDE","User-Agent":"CLI/2.177.0 CodeBuddy/2.177.0"},timeout:15000},res=>{let buf="";res.on("data",c=>buf+=c);res.on("end",()=>{try{resolve({status:res.statusCode,data:JSON.parse(buf)});}catch(e){resolve({status:res.statusCode,raw:buf});}});});req.on("error",reject);req.on("timeout",()=>{req.destroy();reject(new Error("网络请求超时"));});req.write(data);req.end();});}let res=null;if(cred.enterpriseId){try{res=await requestPost("/billing/meter/get-enterprise-user-usage",{});}catch(_){}}const rData=res&&res.data&&res.data.data;if(rData&&typeof rData.credit==="number"){const limit=typeof rData.limitNum==="number"?rData.limitNum:0;const used=Math.round(rData.credit*10)/10;const left=limit===-1?null:Math.max(0,Math.round((limit-used)*10)/10);const remainingPercent=limit>0?Math.max(0,Math.min(100,Math.round((left/limit)*1000)/10)):limit===-1?100:0;const usedPercent=limit>0?Math.max(0,Math.min(100,Math.round((used/limit)*1000)/10)):0;let resetsAt=null;if(rData.cycleResetTime||rData.cycleEndTime){const parsed=Date.parse((rData.cycleResetTime||rData.cycleEndTime).replace(/-/g,"/"));if(!isNaN(parsed)) resetsAt=parsed;}console.log(JSON.stringify({ok:true,enterpriseName:cred.enterpriseName,userName:cred.userName,accountType:cred.accountType,uid:cred.uid,limitNum:limit,used,left,remainingPercent,usedPercent,cycleStartTime:rData.cycleStartTime,cycleEndTime:rData.cycleEndTime,resetsAt,fetchedAt:Date.now()}));return;}const sumRes=await requestPost("/billing/meter/get-user-resource-summary",{});const sData=sumRes&&sumRes.data&&sumRes.data.data;if(sData){console.log(JSON.stringify({ok:true,enterpriseName:cred.enterpriseName,userName:cred.userName,accountType:cred.accountType,uid:cred.uid,limitNum:null,used:0,left:null,remainingPercent:100,usedPercent:0,packages:sData.Packages||[],fetchedAt:Date.now()}));return;}console.log(JSON.stringify({error:res?.data?.msg||"查询 CodeBuddy 额度失败"}));}catch(err){console.log(JSON.stringify({error:err.message||String(err)}));}})();';

    try {
      const res = await ctx.bridge.invoke("plugin_exec_run", {
        bin: "node",
        args: ["-e", nodeInlineCode],
        timeoutMs: 25000,
      });

      if (res.code !== 0) {
        return { error: `Node 退出码 ${res.code}` };
      }

      const parsed = JSON.parse(res.stdout);
      if (parsed.error) {
        return { error: parsed.error };
      }
      return parsed;
    } catch (e) {
      return { error: e.message || String(e) };
    }
  }

  // ── 本地多源 Token 与消耗统计扫描器 ──────────────────────────────────────────
  async function fetchLocalUsageStats() {
    const runnerCode =
      'const fs=require("fs"),path=require("path"),os=require("os");' +
      'const h=os.homedir();' +
      'const p=[path.join(h,".ccgui-next","plugins","ai-quota-monitor","usage-scanner.cjs"),' +
      'path.join(h,".ccgui-next","plugins","ai-quota-monitor","scripts","usage-scanner.cjs"),' +
      'path.join(h,"ccgui-plugins","ai-quota-monitor","scripts","usage-scanner.cjs")];' +
      'const t=p.find(x=>fs.existsSync(x));' +
      'if(t){const mod=require(t);if(typeof mod.runScan==="function"){Promise.resolve(mod.runScan()).then(res=>process.stdout.write(JSON.stringify(res))).catch(err=>process.stdout.write(JSON.stringify({error:err.message})));}}' +
      'else{process.stdout.write(JSON.stringify({error:"Scanner not found"}));}';

    try {
      const res = await ctx.bridge.invoke("plugin_exec_run", {
        bin: "node",
        args: ["--no-warnings", "-e", runnerCode],
        timeoutMs: 30000,
      });
      if (res.code !== 0) {
        console.warn("[ai-quota-monitor] usage scan error:", res.stderr);
        return null;
      }
      const raw = (res.stdout || "").trim();
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start >= 0 && end > start) {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        if (parsed && !parsed.error) {
          return parsed;
        }
      }
      return null;
    } catch (e) {
      console.warn("[ai-quota-monitor] usage scan failed:", e);
      return null;
    }
  }

  function preserveQuotaAfterFailure(result, previous) {
    if (result?.clearPrevious) return result;
    if (result && !result.error) return result;
    if (previous && !previous.error) {
      return {
        ...previous,
        refreshError: result && result.error ? result.error : "查询失败",
      };
    }
    return result || { error: "查询失败" };
  }

  const requestQuota = (request) => ctx.bridge.invoke("plugin_http_request", request);
  const hostQuota = (provider) => ({
    connect: true,
    manualOnly: true,
    fetch: () => fetchHostQuota(ctx.limits?.get, provider),
    render: renderQuotaWindows,
  });
  const services = {
    gemini: {
      name: "Gemini", detail: "Antigravity 配额", icon: GeminiIcon,
      fetch: fetchGeminiQuota,
      render: (data, cfg) => renderModelCards("Gemini", GeminiIcon, data, cfg),
    },
    codex: {
      name: "Codex", detail: "ChatGPT 订阅配额", icon: OpenAiIcon,
      fetch: fetchCodexQuota,
      render: (data, cfg) => renderModelCards("Codex (ChatGPT)", OpenAiIcon, data, cfg),
    },
    codebuddy: {
      name: "CodeBuddy", detail: "账号积分", icon: CodeBuddyIcon,
      fetch: fetchCodeBuddyQuota,
      render: (data, cfg) => renderCodeBuddyCards("CodeBuddy", CodeBuddyIcon, data, cfg),
    },
    opencode: {
      name: "OpenCode", detail: "Go 配额与 Console 预算", icon: OpenCodeIcon,
      connect: true, autoLocal: true, channel: "opencode-go",
      fetch: (connection) => {
        if (connection.mode === "channel") return fetchHostQuota(ctx.limits?.get, "opencode-go");
        if (connection.mode === "go") return fetchOpenCodeGo(requestQuota, connection);
        return fetchOpenCodeLimits(requestQuota, connection);
      },
      render: renderQuotaWindows,
    },
    grok: {
      name: "Grok", detail: "xAI API 团队额度", icon: GrokIcon,
      connect: true, fetch: (connection) => fetchGrokBilling(requestQuota, connection),
      render: (data) => renderGrokCards(data),
    },
    glm: {
      name: "GLM 编码套餐", tabLabel: "GLM", detail: "智谱 / Z.AI 订阅配额", icon: GlmIcon,
      connect: true, channel: "glm", fetch: (connection) => connection.mode === "channel"
        ? fetchHostQuota(ctx.limits?.get, "glm") : fetchGlmQuota(requestQuota, connection),
      render: renderQuotaWindows,
    },
    kimi: {
      name: "Kimi Coding", tabLabel: "Kimi", detail: "Kimi Code 套餐配额", icon: KimiIcon,
      connect: true, channel: "kimi", fetch: (connection) => connection.mode === "channel"
        ? fetchHostQuota(ctx.limits?.get, "kimi") : fetchKimiQuota(requestQuota, connection),
      render: renderQuotaWindows,
    },
    claude: {
      name: "Claude 订阅", detail: "Claude Code 登录账号", icon: ClaudeSubscriptionIcon,
      cli: "Claude Code", ...hostQuota("claude"),
    },
    "grok-subscription": {
      name: "Grok 订阅", detail: "Grok Build 编码配额", icon: GrokIcon,
      cli: "Grok Build", ...hostQuota("grok"),
    },
  };
  const knownServiceIds = Object.keys(services);

  function serviceForEngine(engine) {
    if (engine === "omp" || engine === "agy") return "gemini";
    if (engine === "grok" && !visibleServices.includes("grok")) return "grok-subscription";
    return knownServiceIds.includes(engine) ? engine : null;
  }

  function legacyCacheData(cache = cachedData) {
    return Object.fromEntries(
      ["gemini", "codex", "codebuddy", "fetchedAt", "usageStats"]
        .filter((key) => cache && Object.hasOwn(cache, key))
        .map((key) => [key, cache[key]]),
    );
  }

  function persistCache() {
    const legacyData = legacyCacheData();
    cacheWrite = cacheWrite.then(async () => {
      if (!disposed) await ctx.storage.set("cached_quota", legacyData);
    }).catch(() => {
      if (!disposed) console.warn("[ai-quota-monitor] 无法保存配额缓存");
    });
  }

  function fetchProvider(id) {
    if (disposed || ctx.host?.isWeb || !visibleServices.includes(id)) return Promise.resolve(false);
    if (pending.has(id)) return pending.get(id);
    const service = services[id];
    const connection = connections.get(id);
    if (service.connect && !connection) return Promise.resolve(false);

    const task = Promise.resolve().then(() => service.fetch(connection))
      .catch(() => ({ error: "查询失败，请稍后重试。" }))
      .then((result) => {
        if (disposed || !visibleServices.includes(id) || connections.get(id) !== connection) return false;
        const value = preserveQuotaAfterFailure(result, cachedData?.[id]);
        const fresh = !value.error && !value.refreshError;
        cachedData = {
          ...cachedData,
          [id]: value,
          ...(fresh && !service.connect ? { fetchedAt: value.fetchedAt } : {}),
        };
        if (!service.connect) void persistCache();
        return fresh && !value.notice;
      }).finally(() => {
        if (pending.get(id) === task) pending.delete(id);
        if (!disposed) notifySubscribers();
      });
    pending.set(id, task);
    notifySubscribers();
    return task;
  }

  async function fetchQuota(manual = false) {
    if (!initialized || disposed || ctx.host?.isWeb) return;
    const ids = visibleServices.filter((id) => {
      if (manual) return true;
      const connection = connections.get(id);
      return !services[id].manualOnly && connection?.mode !== "channel"
        && !(connection?.detected && cachedData?.[id]?.error);
    });
    await Promise.all([...ids.map(fetchProvider), fetchUsageOnly()]);
    if (disposed || !cachedData) return;
    try {
      ctx.events.emit(`plugin:${ctx.pluginId}:updated`, legacyCacheData());
    } catch {
      // Unload may revoke the event capability while a lookup finishes.
    }
  }

  async function fetchUsageOnly() {
    if (disposed || ctx.host?.isWeb || isFetchingUsage) return false;
    isFetchingUsage = true;
    notifySubscribers();
    try {
      const result = await fetchLocalUsageStats();
      if (!result || result.error || disposed) return false;
      cachedData = { ...cachedData, usageStats: result };
      void persistCache();
      return true;
    } finally {
      isFetchingUsage = false;
      if (!disposed) notifySubscribers();
    }
  }

  function disconnectService(id) {
    connections.delete(id);
    pending.delete(id);
    if (cachedData && services[id].connect) {
      const { [id]: removed, ...remaining } = cachedData;
      cachedData = remaining;
    }
  }

  function connectService(id, connection) {
    disconnectService(id);
    connections.set(id, connection);
    return fetchProvider(id);
  }

  function probeLocalService(id) {
    if (!services[id]?.autoLocal || !probeOpenCode || ctx.host?.isWeb || !visibleServices.includes(id) || connections.has(id)) return;
    void connectService(id, { mode: "local", detected: true });
  }

  async function saveVisibleServices(selection) {
    const next = normalizeVisibleServices(selection, knownServiceIds);
    await ctx.storage.set("visible_quota_services", next);
    if (disposed) return;
    const added = next.filter((id) => !visibleServices.includes(id));
    for (const id of visibleServices) {
      if (!next.includes(id) && services[id].connect) {
        disconnectService(id);
        if (services[id].autoLocal) probeOpenCode = true;
      }
    }
    visibleServices = next;
    preferredService = resolveService(next, preferredService, serviceForEngine(activeEngine));
    notifySubscribers();
    for (const id of added) {
      if (!services[id].connect && autoRefreshMinutes() > 0) void fetchProvider(id);
    }
    probeLocalService(preferredService);
  }

  function useQuotaState() {
    const [state, setState] = useState(quotaSnapshot);
    useEffect(() => {
      subscribers.add(setState);
      setState(quotaSnapshot());
      return () => { subscribers.delete(setState); };
    }, []);
    return state;
  }

  // ── 单模型指标卡片渲染辅助 ──────────────────────────────────────────────────
  function renderModelCards(title, BrandIcon, modelData, config) {
    if (!modelData || modelData.error) {
      return h(
        "div",
        {
          className: "gqc-popover-card",
          style: {
            minHeight: "220px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            textAlign: "center",
            gap: "8px",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px", fontWeight: 600 } },
          h(BrandIcon, { size: 16 }),
          h("span", null, title)
        ),
        h(
          "div",
          { style: { color: "var(--color-text-tertiary, #a1a1aa)", fontSize: "11px", maxWidth: "260px" } },
          modelData && modelData.error ? modelData.error : "暂无配额数据"
        )
      );
    }

    const weekly = modelData.weekly;
    const h5 = modelData.h5;

    const weeklyTone = weekly ? getStatusTone(weekly.remaining, config && config.warningThreshold) : "safe";
    const weeklyColor = getToneColor(weeklyTone);

    const h5Tone = h5 ? getStatusTone(h5.remaining, config && config.warningThreshold) : "safe";
    const h5Color = getToneColor(h5Tone);

    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "8px" } },
      // 头部账号
      h(
        "div",
        {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "11px",
            color: "var(--color-text-secondary, #71717a)",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "5px" } },
          h(BrandIcon, { size: 14 }),
          h("span", { style: { fontWeight: 600, color: "var(--color-text-primary, #18181b)" } }, title),
          modelData.planType
            ? h(
                "span",
                {
                  style: {
                    padding: "1px 4px",
                    borderRadius: "3px",
                    fontSize: "9.5px",
                    fontWeight: 600,
                    background: "rgba(16, 185, 129, 0.12)",
                    color: "#059669",
                  },
                },
                modelData.planType
              )
            : title.includes("Gemini")
              ? h(
                  "span",
                  {
                    style: {
                      padding: "1px 4px",
                      borderRadius: "3px",
                      fontSize: "9.5px",
                      fontWeight: 600,
                      background: "rgba(2, 132, 199, 0.12)",
                      color: "#0284c7",
                    },
                  },
                  modelData.source === "omp" ? "Antigravity (OMP)" : "Antigravity (AGY)"
                )
              : null
        ),
        h(
          "span",
          {
            style: {
              fontSize: "11px",
              color: "var(--color-text-secondary, #71717a)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: "160px",
            },
          },
          modelData.email || ""
        )
      ),
      modelData.refreshError
        ? h(
            "div",
            {
              title: modelData.refreshError,
              style: {
                color: "#b45309",
                fontSize: "10px",
                lineHeight: "1.3",
                marginTop: "-4px",
              },
            },
            "刷新失败，当前显示上次成功的额度"
          )
        : null,
      // 7D 周限卡片
      h(
        "div",
        { className: "gqc-popover-card" },
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
          h(
            "span",
            { style: { fontWeight: 600, fontSize: "11.5px", color: "var(--color-text-primary, #18181b)" } },
            "每周总限额 (7D)"
          ),
          h(
            "span",
            { style: { fontSize: "17px", fontWeight: 700, color: weeklyColor } },
            weekly ? `${weekly.remaining}%` : "--"
          )
        ),
        h(
          "div",
          { className: "gqc-progress-track" },
          h("div", {
            className: "gqc-progress-bar",
            style: {
              width: `${weekly ? Math.max(0, Math.min(100, weekly.remaining)) : 0}%`,
              backgroundColor: weeklyColor,
            },
          })
        ),
        h(
          "div",
          {
            style: {
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "4px 8px",
              fontSize: "11px",
              color: "var(--color-text-secondary, #71717a)",
            },
          },
          h("div", null, "已用: ", h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, weekly ? `${weekly.used}%` : "--")),
          h("div", null, "周期: 7 天"),
          h(
            "div",
            { style: { gridColumn: "1 / -1" } },
            "重置倒计时: ",
            h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, weekly ? formatResetTime(weekly.resetsAt) : "--"),
            weekly && weekly.resetsAt ? ` (${formatExactDate(weekly.resetsAt)})` : ""
          )
        )
      ),

      // 5H 短周期限额卡片
      h(
        "div",
        { className: "gqc-popover-card" },
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
          h(
            "span",
            { style: { fontWeight: 600, fontSize: "11.5px", color: "var(--color-text-primary, #18181b)" } },
            "5 小时短周期 (5H)"
          ),
          h(
            "span",
            { style: { fontSize: "16px", fontWeight: 700, color: h5Color } },
            h5 ? `${h5.remaining}%` : "--"
          )
        ),
        h(
          "div",
          { className: "gqc-progress-track" },
          h("div", {
            className: "gqc-progress-bar",
            style: {
              width: `${h5 ? Math.max(0, Math.min(100, h5.remaining)) : 0}%`,
              backgroundColor: h5Color,
            },
          })
        ),
        h(
          "div",
          {
            style: {
              display: "flex",
              justifyContent: "space-between",
              fontSize: "11px",
              color: "var(--color-text-secondary, #71717a)",
            },
          },
          h("span", null, "已用: ", h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, h5 ? `${h5.used}%` : "--")),
          h(
            "span",
            null,
            "重置倒计时: ",
            h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, h5 ? formatResetTime(h5.resetsAt) : "--")
          )
        )
      ),

      // 额度券或扩展能力辅助提示条 (统一各看板高度与结构节奏)
      modelData.resetCredits !== undefined
        ? h(
            "div",
            { className: "gqc-aux-strip is-codex" },
            h("span", { className: "gqc-aux-label" }, "🎟️ 月度额度重置券:"),
            h("b", null, `${modelData.resetCredits} 次可用`)
          )
        : modelData.p3Weekly
          ? h(
              "div",
              { className: "gqc-aux-strip is-gemini" },
              h("span", { className: "gqc-aux-label" }, "🤖 第三方模型周限 (Claude/GPT):"),
              h("b", null, `${modelData.p3Weekly.remaining}% 可用`)
            )
          : modelData.projectId
            ? h(
                "div",
                { className: "gqc-aux-strip is-gemini" },
                h("span", { className: "gqc-aux-label" }, "🏢 关联云项目 (Project):"),
                h("b", null, modelData.projectId)
              )
            : h(
                "div",
                { className: "gqc-aux-strip is-default" },
                h("span", { className: "gqc-aux-label" }, "⚡ 配额调度机制:"),
                h("b", null, "5H 平滑突发 · 7D 周限保护")
              )
    );
  }

  // ── CodeBuddy 账号积分指标卡片渲染辅助 ─────────────────────────────────────
  function renderCodeBuddyCards(title, BrandIcon, modelData, config) {
    if (!modelData || modelData.error) {
      return h(
        "div",
        {
          className: "gqc-popover-card",
          style: {
            minHeight: "220px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            textAlign: "center",
            gap: "8px",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "6px", fontWeight: 600 } },
          h(BrandIcon, { size: 16 }),
          h("span", null, title)
        ),
        h(
          "div",
          { style: { color: "var(--color-text-tertiary, #a1a1aa)", fontSize: "11px", maxWidth: "260px" } },
          modelData && modelData.error ? modelData.error : "暂无 CodeBuddy 积分数据"
        )
      );
    }

    const isUnlimited = modelData.limitNum === -1;
    const tone = isUnlimited ? "safe" : getStatusTone(modelData.remainingPercent, config && config.warningThreshold);
    const color = getToneColor(tone);

    function formatNumber(num) {
      if (typeof num !== "number") return "--";
      return num.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
    }

    let typeLabel = "CodeBuddy";
    if (modelData.accountType) {
      const t = String(modelData.accountType).toLowerCase();
      if (t === "ultimate") typeLabel = "旗舰版";
      else if (t === "pro") typeLabel = "专业版";
      else if (t === "personal") typeLabel = "个人版";
      else typeLabel = modelData.accountType;
    }

    const accountSubtitle = [
      modelData.userName,
      modelData.enterpriseName,
    ].filter(Boolean).join(" · ");

    let cycleProgressPct = 0;
    if (modelData.cycleStartTime && modelData.cycleEndTime) {
      try {
        const s = new Date(modelData.cycleStartTime.replace(/-/g, "/")).getTime();
        const e = new Date(modelData.cycleEndTime.replace(/-/g, "/")).getTime();
        const n = Date.now();
        if (e > s) {
          cycleProgressPct = Math.max(0, Math.min(100, Math.round(((n - s) / (e - s)) * 100)));
        }
      } catch (_) {}
    }

    return h(
      "div",
      { style: { display: "flex", flexDirection: "column", gap: "8px" } },
      // 头部账号
      h(
        "div",
        {
          style: {
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: "11px",
            color: "var(--color-text-secondary, #71717a)",
          },
        },
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "5px" } },
          h(BrandIcon, { size: 14 }),
          h("span", { style: { fontWeight: 600, color: "var(--color-text-primary, #18181b)" } }, title),
          h(
            "span",
            {
              style: {
                padding: "1px 5px",
                borderRadius: "3px",
                fontSize: "9.5px",
                fontWeight: 600,
                background: "rgba(46, 169, 157, 0.12)",
                color: "#2ea99d",
              },
            },
            typeLabel
          )
        ),
        h(
          "span",
          {
            style: {
              fontSize: "11px",
              color: "var(--color-text-secondary, #71717a)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              maxWidth: "180px",
            },
          },
          accountSubtitle || modelData.uid || ""
        )
      ),
      modelData.refreshError
        ? h(
            "div",
            {
              title: modelData.refreshError,
              style: {
                color: "#b45309",
                fontSize: "10px",
                lineHeight: "1.3",
                marginTop: "-4px",
              },
            },
            "刷新失败，当前显示上次成功的额度"
          )
        : null,

      // 1. 月度可用积分卡片 (结构与每周总限额卡片严格对齐)
      h(
        "div",
        { className: "gqc-popover-card" },
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
          h(
            "span",
            { style: { fontWeight: 600, fontSize: "11.5px", color: "var(--color-text-primary, #18181b)" } },
            "本月可用积分 (Monthly)"
          ),
          h(
            "span",
            { style: { fontSize: "17px", fontWeight: 700, color } },
            isUnlimited ? "不限额" : `${modelData.remainingPercent}%`
          )
        ),
        h(
          "div",
          { className: "gqc-progress-track" },
          h("div", {
            className: "gqc-progress-bar",
            style: {
              width: `${isUnlimited ? 100 : Math.max(0, Math.min(100, modelData.remainingPercent))}%`,
              backgroundColor: color,
            },
          })
        ),
        h(
          "div",
          {
            style: {
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "4px 8px",
              fontSize: "11px",
              color: "var(--color-text-secondary, #71717a)",
            },
          },
          h(
            "div",
            null,
            "剩余: ",
            h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, isUnlimited ? "无限制" : `${formatNumber(modelData.left)} 积分`)
          ),
          h(
            "div",
            null,
            "已用: ",
            h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, `${formatNumber(modelData.used)} 积分`)
          ),
          h(
            "div",
            null,
            "总额: ",
            h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, isUnlimited ? "无限制" : `${formatNumber(modelData.limitNum)} 积分`)
          ),
          h(
            "div",
            null,
            "已用占比: ",
            h("b", { style: { color: "var(--color-text-primary, #18181b)" } }, `${modelData.usedPercent}%`)
          )
        )
      ),

      // 2. 结算周期与重置卡片 (结构与 5H 短周期卡片严格对齐)
      h(
        "div",
        { className: "gqc-popover-card" },
        h(
          "div",
          { style: { display: "flex", justifyContent: "space-between", alignItems: "baseline" } },
          h(
            "span",
            { style: { fontWeight: 600, fontSize: "11.5px", color: "var(--color-text-primary, #18181b)" } },
            "结算周期与重置 (Cycle)"
          ),
          h(
            "span",
            { style: { fontSize: "13px", fontWeight: 700, color: "#2ea99d" } },
            modelData.resetsAt ? formatResetTime(modelData.resetsAt) : "月度结算"
          )
        ),
        h(
          "div",
          { className: "gqc-progress-track" },
          h("div", {
            className: "gqc-progress-bar",
            style: {
              width: `${cycleProgressPct || 100}%`,
              backgroundColor: "#2ea99d",
            },
          })
        ),
        h(
          "div",
          {
            style: {
              display: "flex",
              justifyContent: "space-between",
              fontSize: "11px",
              color: "var(--color-text-secondary, #71717a)",
            },
          },
          h(
            "span",
            null,
            "周期: ",
            h(
              "b",
              { style: { color: "var(--color-text-primary, #18181b)" } },
              modelData.cycleStartTime && modelData.cycleEndTime
                ? `${modelData.cycleStartTime.slice(5, 10)} ~ ${modelData.cycleEndTime.slice(5, 10)}`
                : "自然月"
            )
          ),
          h(
            "span",
            null,
            "重置时间: ",
            h(
              "b",
              { style: { color: "var(--color-text-primary, #18181b)" } },
              modelData.resetsAt ? formatExactDate(modelData.resetsAt) : "--"
            )
          )
        )
      ),

      // 3. 账号权益状态条 (结构与月度重置券条严格对齐)
      h(
        "div",
        { className: "gqc-aux-strip is-codebuddy" },
        h("span", { className: "gqc-aux-label" }, "🎫 账号权益:"),
        h("b", null, `${typeLabel} · 专享高并发与优先通道`)
      )
    );
  }

  // ── GitHub 风格日历用量热力图组件 ──────────────────────────────────────────
  function renderCalendarHeatmap(heatmapData) {
    const rawData = heatmapData || {};
    const now = new Date();
    const numWeeks = 24; // 近 6 个月 (24 周)
    const startDate = new Date(now);
    startDate.setDate(now.getDate() - (numWeeks * 7) - now.getDay());

    const weeks = [];
    let currWeek = [];
    let activeDaysCount = 0;
    let maxTokens = 0;

    for (let d = new Date(startDate); d <= now; d.setDate(d.getDate() + 1)) {
      const dayOfWeek = d.getDay();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const dateStr = `${y}-${m}-${day}`;
      const entry = rawData[dateStr];
      const tok = entry ? Number(entry.tokens || 0) : 0;
      const cost = entry ? Number(entry.cost || 0) : 0;
      if (tok > 0) activeDaysCount++;
      if (tok > maxTokens) maxTokens = tok;
      currWeek.push({
        dateStr,
        dayOfWeek,
        month: d.getMonth() + 1,
        dayNum: d.getDate(),
        tok,
        cost,
      });
      if (dayOfWeek === 6 || d.getTime() >= now.getTime()) {
        weeks.push(currWeek);
        currWeek = [];
      }
    }
    if (currWeek.length > 0) weeks.push(currWeek);

    function getLevel(tok) {
      if (!tok || tok === 0) return 0;
      if (tok < 10e6) return 1;
      if (tok < 50e6) return 2;
      if (tok < 150e6) return 3;
      return 4;
    }

    // 构建月份标尺
    const monthLabels = [];
    let lastMonth = null;
    for (let w = 0; w < weeks.length; w++) {
      const firstDay = weeks[w][0];
      if (firstDay && firstDay.month !== lastMonth && firstDay.dayNum <= 7) {
        monthLabels.push(
          h(
            "span",
            {
              key: `m-${w}`,
              style: { position: "absolute", left: `${w * 11.5 + 18}px` },
            },
            `${firstDay.month}月`
          )
        );
        lastMonth = firstDay.month;
      }
    }

    // 构建 24 周列
    const columns = weeks.map((week, wIdx) => {
      const cells = [];
      for (let r = 0; r < 7; r++) {
        const day = week.find((d) => d.dayOfWeek === r);
        if (!day) {
          cells.push(h("div", { key: `empty-${r}`, style: { width: "9.5px", height: "9.5px" } }));
        } else {
          const lvl = getLevel(day.tok);
          const tooltip = day.tok > 0
            ? `${day.dateStr}: ${formatTokensShort(day.tok)} Token (${formatCostDisplay(day.cost)})`
            : `${day.dateStr}: 无记录`;
          cells.push(
            h("div", {
              key: day.dateStr,
              className: `gqc-heat-cell lvl-${lvl}`,
              title: tooltip,
            })
          );
        }
      }
      return h("div", { key: `col-${wIdx}`, className: "gqc-heat-col" }, cells);
    });

    return h(
      "div",
      { className: "gqc-heat-wrap" },
      h(
        "div",
        { className: "gqc-heat-header" },
        h(
          "div",
          { className: "gqc-heat-title" },
          h("span", { style: { fontSize: "11px" } }, "📅"),
          h("span", null, "用量热力图")
        ),
        h("div", { className: "gqc-heat-sub" }, `近半年活跃 ${activeDaysCount} 天`)
      ),
      h(
        "div",
        { className: "gqc-heat-scroll" },
        h(
          "div",
          { className: "gqc-heat-grid-container" },
          h("div", { className: "gqc-heat-months-row" }, monthLabels),
          h(
            "div",
            { className: "gqc-heat-body-row" },
            h(
              "div",
              { className: "gqc-heat-day-labels" },
              h("span", null, "日"),
              h("span", null, "一"),
              h("span", null, "二"),
              h("span", null, "三"),
              h("span", null, "四"),
              h("span", null, "五"),
              h("span", null, "六")
            ),
            h("div", { className: "gqc-heat-weeks-flow" }, columns)
          )
        )
      ),
      h(
        "div",
        { className: "gqc-heat-legend-row" },
        h("span", null, "少"),
        h("div", { className: "gqc-heat-legend-cell lvl-0" }),
        h("div", { className: "gqc-heat-legend-cell lvl-1" }),
        h("div", { className: "gqc-heat-legend-cell lvl-2" }),
        h("div", { className: "gqc-heat-legend-cell lvl-3" }),
        h("div", { className: "gqc-heat-legend-cell lvl-4" }),
        h("span", null, "多")
      )
    );
  }

  // ── 本地全场景 Token 与成本使用统计视图 ───────────────────────────────────
  // ── 本地全场景 Token 与成本使用统计视图 (与 Image 1 深度对齐) ──────────────────
  function renderUsageStatsView(
    usageStats,
    loading,
    usageLoading,
    config,
    usageRange,
    setUsageRange,
    onRefreshUsage,
    selectedProvider,
    setSelectedProvider
  ) {
    if (!usageStats) {
      return h(
        "div",
        {
          style: {
            padding: "36px 16px",
            textAlign: "center",
            color: "var(--color-text-secondary, #71717a)",
            fontSize: "12px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "10px",
          },
        },
        loading
          ? [h(RefreshIcon, { spinning: true, size: 18 }), "正在扫描 Token 消耗..."]
          : "暂未发现本地会话用量数据，点击右上角刷新"
      );
    }

    const currentRangeData = usageStats[usageRange] || usageStats.today || {
      totalTokens: 0,
      totalTokensFormatted: "0",
      totalCost: 0,
      totalCostFormatted: "$0.00",
      totalModels: 0,
      providers: [],
      allModels: [],
    };

    const activeProvider =
      (currentRangeData.providers && currentRangeData.providers.find((p) => p.name === selectedProvider)) ||
      (currentRangeData.providers && currentRangeData.providers[0]) || { name: "全部", isAll: true, models: currentRangeData.allModels };

    const isFiltered = activeProvider && !activeProvider.isAll;
    const displayModels = (activeProvider && activeProvider.models && activeProvider.models.length > 0)
      ? activeProvider.models
      : currentRangeData.allModels;

    const onCardClick = (pName) => {
      if (setSelectedProvider) {
        setSelectedProvider((prev) => (prev === pName && pName !== "全部" ? "全部" : pName));
      }
    };

    const rangeLabels = [
      { id: "today", label: "日" },
      { id: "week", label: "周" },
      { id: "month", label: "月" },
      { id: "all", label: "总计" },
    ];

    return h(
      "div",
      { className: "gqc-stat-container" },

      // 时间筛选胶囊 + 右侧独立刷新按钮
      h(
        "div",
        { className: "gqc-stat-filter-bar" },
        h(
          "div",
          { className: "gqc-stat-pills" },
          rangeLabels.map(({ id, label }) =>
            h(
              "button",
              {
                key: id,
                type: "button",
                className: `gqc-stat-pill-btn${usageRange === id ? " is-active" : ""}`,
                onClick: () => setUsageRange(id),
              },
              label
            )
          )
        ),
        h(
          "button",
          {
            type: "button",
            className: "gqc-stat-refresh-btn",
            title: "仅刷新用量统计 (不刷新配额)",
            disabled: usageLoading,
            onClick: onRefreshUsage,
          },
          h(RefreshIcon, { spinning: usageLoading, size: 12 })
        )
      ),

      // 居中大指标展示 (TOKEN 总数, 106.4M / 1.7B, $13.51 / $251.50)
      h(
        "div",
        { className: "gqc-stat-hero" },
        h("span", { className: "gqc-stat-hero-label" }, usageRange === "today" ? "TOKEN 总数 (今日)" : "TOKEN 消耗总数"),
        h("span", { className: "gqc-stat-hero-number" }, currentRangeData.totalTokensFormatted || "0"),
        h("span", { className: "gqc-stat-hero-cost" }, currentRangeData.totalCostFormatted || "$0.00"),
        currentRangeData.totalTokens === 0
          ? h("span", { style: { fontSize: "10.5px", color: "var(--color-text-secondary, #52525b)", marginTop: "4px" } }, "今日暂无消耗 · 点击「周」或「月」查看用量")
          : null
      ),

      // 多色分段进度条
      currentRangeData.providers && currentRangeData.providers.length > 1
        ? h(
            "div",
            { className: "gqc-stat-seg-bar" },
            currentRangeData.providers
              .filter((p) => !p.isAll)
              .map((p) =>
                h("div", {
                  key: p.name,
                  className: "gqc-stat-seg-part",
                  style: {
                    width: `${Math.max(1, p.percent)}%`,
                    backgroundColor: getProviderColor(p.name),
                  },
                  title: `${p.name}: ${p.percent}% (${p.tokensFormatted})`,
                })
              )
          )
        : null,

      // 供应商 2 列卡片网格 (支持点击筛选)
      h(
        "div",
        { className: "gqc-stat-grid" },
        currentRangeData.providers.map((p) => {
          const isSelected = selectedProvider === p.name || (p.isAll && (!selectedProvider || selectedProvider === "全部"));
          return h(
            "div",
            {
              key: p.name,
              className: `gqc-stat-provider-card${isSelected ? " is-selected" : ""}`,
              onClick: () => onCardClick(p.name),
              title: isSelected ? "点击取消筛选，展示全部模型" : `点击筛选查看 ${p.name} 模型用量`,
            },
            h(
              "div",
              { className: "gqc-stat-provider-head" },
              h(
                "div",
                { className: "gqc-stat-provider-title" },
                renderProviderIcon(p.name, 11),
                p.name
              ),
              h("div", { className: "gqc-stat-provider-models" }, `${p.modelCount} 模型`)
            ),
            h("div", { className: "gqc-stat-provider-pct" }, `${p.percent.toFixed(2)}%`),
            h("div", { className: "gqc-stat-provider-meta" }, p.tokens > 0 ? `${p.tokensFormatted} · ${p.costFormatted}` : "0 Token · $0.00")
          );
        })
      ),

      // 模型用量排行榜 (跟随卡片点击动态过滤)
      displayModels && displayModels.length > 0
        ? h(
            "div",
            { className: "gqc-stat-all-models-wrap" },
            h(
              "div",
              {
                className: "gqc-stat-all-models-title-row",
                style: { display: "flex", justifyContent: "space-between", alignItems: "center" },
              },
              h(
                "div",
                { style: { display: "flex", alignItems: "center", gap: "5px" } },
                renderProviderIcon(isFiltered ? activeProvider.name : "全部", 12),
                isFiltered
                  ? `${activeProvider.name} 模型用量 (${activeProvider.modelCount} 模型)`
                  : "全部模型"
              ),
              isFiltered
                ? h(
                    "button",
                    {
                      type: "button",
                      style: {
                        background: "transparent",
                        border: "none",
                        color: "#2563eb",
                        fontSize: "10.5px",
                        cursor: "pointer",
                        fontWeight: 600,
                        padding: "0 2px",
                      },
                      onClick: () => setSelectedProvider && setSelectedProvider("全部"),
                    },
                    "显示全部 ✕"
                  )
                : null
            ),
            h(
              "div",
              { className: "gqc-stat-all-models-sub" },
              isFiltered
                ? `仅展示 ${activeProvider.name} 产生的消耗 · 点击卡片取消筛选`
                : "同名模型会跨工具合并，并按总用量排序。"
            ),
            h(
              "div",
              { className: "gqc-stat-all-models-list" },
              displayModels.slice(0, 15).map((m) =>
                h(
                  "div",
                  { key: m.name, className: "gqc-stat-all-model-row" },
                  h(
                    "div",
                    { className: "gqc-stat-all-model-info" },
                    h("span", { className: "gqc-stat-all-model-name", title: m.name }, m.name),
                    h(
                      "div",
                      { className: "gqc-stat-all-model-bar-track" },
                      h("div", {
                        className: "gqc-stat-all-model-bar-fill",
                        style: { width: `${Math.min(100, Math.max(3, m.percent))}%` },
                      })
                    )
                  ),
                  h(
                    "div",
                    { className: "gqc-stat-all-model-nums" },
                    h("span", { className: "gqc-stat-all-model-tokens" }, m.tokensFormatted),
                    h("span", { className: "gqc-stat-all-model-cost" }, m.costFormatted),
                    h("span", { className: "gqc-stat-all-model-pct" }, `${m.percent}%`)
                  )
                )
              )
            )
          )
        : null,

      // 日历活跃热力图 (GitHub 风格，在全部模型列表下方)
      renderCalendarHeatmap(usageStats.heatmap)
    );
  }
  // ── 弹出详情弹框组件 (单模型看板 Popover Modal) ───────────────────────────
  function renderQuotaWindows(data, config) {
    return h("div", { className: "gqc-quota-stack" },
      data.windows.map((window) => {
        const remaining = Math.round(window.remaining);
        return h("div", { key: window.id, className: "gqc-popover-card" },
          h("div", { className: "gqc-quota-metric" },
            h("strong", null, window.label),
            h("strong", { style: { color: getToneColor(getStatusTone(remaining, config.warningThreshold)) } }, remaining + "%"),
          ),
          h("div", { className: "gqc-progress-track", role: "progressbar",
            "aria-label": window.label + "剩余", "aria-valuenow": remaining },
            h("div", { className: "gqc-progress-bar", style: {
              width: remaining + "%", background: getToneColor(getStatusTone(remaining, config.warningThreshold)),
            } }),
          ),
          h("span", { className: "gqc-quota-muted" }, window.resetsAt
            ? "重置于 " + formatExactDate(window.resetsAt)
            : "暂未提供重置时间"),
        );
      }),
      data.budgets?.length > 0 && h("div", { className: "gqc-popover-card" },
        h("strong", null, "Console 预算"),
        data.budgets.map((budget) => h("div", { key: budget.id, className: "gqc-quota-metric" },
          h("span", null, budget.modelScoped ? "单模型预算" : "预算组",
            budget.resetsAt ? " · " + formatExactDate(budget.resetsAt) + " 重置" : ""),
          h("strong", null, budget.modelScoped
            ? "每模型 " + formatUsd(budget.limit)
            : formatUsd(budget.spent) + " / " + formatUsd(budget.limit)),
        )),
      ),
    );
  }

  function formatUsd(value) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
  }

  function renderGrokCards(data) {
    return h("div", { className: "gqc-quota-stack" },
      [["预付余额", data.balance], ["后付费月度上限", data.postpaidLimit]].map(([label, value]) =>
        h("div", { key: label, className: "gqc-popover-card gqc-quota-metric" },
          h("strong", null, label),
          h("strong", null, value === null ? "不可用" : formatUsd(value)),
        ),
      ),
      data.notice && h("p", { className: "gqc-quota-message", role: "status" }, data.notice),
    );
  }

  function ManageServices({ visibleIds, onClose }) {
    const [selected, setSelected] = useState(visibleIds);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const firstOption = useRef(null);
    const hintId = useId();
    const atLimit = selected.length >= MAX_VISIBLE_QUOTA_SERVICES;
    const firstEnabledId = atLimit ? knownServiceIds.find((id) => selected.includes(id)) : knownServiceIds[0];
    useEffect(() => { firstOption.current?.focus(); }, []);

    async function save(event) {
      event.preventDefault();
      if (saving) return;
      setSaving(true);
      setError(null);
      try {
        await saveVisibleServices(selected);
        onClose();
      } catch {
        setSaving(false);
        setError("无法保存展示设置，请重试。");
      }
    }

    return h("form", { className: "gqc-quota-stack", onSubmit: save },
      h("p", { id: hintId, className: "gqc-quota-muted" },
        "最多展示 " + MAX_VISIBLE_QUOTA_SERVICES + " 个服务。更换服务时，先取消一项。"),
      h("fieldset", { className: "gqc-service-list", disabled: saving, "aria-label": "要展示的服务", "aria-describedby": hintId },
        knownServiceIds.map((id) => {
          const service = services[id];
          const checked = selected.includes(id);
          return h("label", { key: id, className: "gqc-service-row" },
            h(service.icon, { size: 15 }),
            h("span", { className: "gqc-service-label" },
              h("strong", null, service.name),
              h("span", { className: "gqc-quota-muted" }, service.detail),
            ),
            h("input", {
              type: "checkbox",
              ref: id === firstEnabledId ? firstOption : undefined,
              checked,
              disabled: atLimit && !checked,
              onChange: (event) => {
                const checked = event.target.checked;
                setSelected((ids) => {
                  const next = checked ? [...ids, id] : ids.filter((item) => item !== id);
                  return normalizeVisibleServices(next, knownServiceIds);
                });
              },
            }),
          );
        }),
      ),
      error && h("p", { role: "alert", className: "gqc-quota-message" }, error),
      h("div", { className: "gqc-service-actions" },
        h("span", { className: "gqc-quota-muted", role: "status" }, "已选 " + selected.length + " / " + MAX_VISIBLE_QUOTA_SERVICES + " 项"),
        h("button", { type: "button", className: "gqc-service-button", onClick: onClose, disabled: saving }, "取消"),
        h("button", { type: "submit", className: "gqc-service-button is-primary", disabled: saving }, saving ? "保存中…" : "保存"),
      ),
    );
  }

  function ConnectService({ id, loading }) {
    const [error, setError] = useState(null);
    const [mode, setMode] = useState("local");
    const openCode = id === "opencode";
    const local = openCode && mode === "local";
    const teamBilling = id === "grok";
    const regional = id === "glm";
    const { cli, name, channel } = services[id];

    if (cli) return h("div", { className: "gqc-popover-card gqc-quota-stack" },
      h("p", { className: "gqc-quota-muted" }, "先在 " + cli + " 登录订阅账号，再连接查询。"),
      h("div", { className: "gqc-service-actions" },
        h("button", { type: "button", className: "gqc-service-button is-primary", disabled: loading,
          onClick: () => connectService(id, {}) }, "连接 CLI 账号"),
      ),
    );

    function submit(event) {
      event.preventDefault();
      if (loading) return;
      const form = event.currentTarget;
      const team = teamBilling ? form.elements.team.value.trim() : undefined;
      const region = regional ? form.elements.region.value : undefined;
      const inputSecret = form.elements.secret.value;
      const secret = local ? inputSecret : inputSecret.trim();
      if (!local && (!validQuotaSecret(secret) || (teamBilling && !validGrokTeam(team)))) {
        setError(teamBilling ? "请检查 Team ID 和 Management API Key。" : "请输入有效的套餐 API Key。");
        return;
      }
      form.reset();
      setError(null);
      connectService(id, { team, region, secret, mode });
    }

    const form = h("form", { className: "gqc-popover-card gqc-quota-stack", onSubmit: submit, autoComplete: "off" },
      h("strong", null, teamBilling ? "连接 xAI API 团队" : "连接 " + name),
      openCode && h("label", { className: "gqc-service-field" }, "连接方式",
        h("select", { value: mode, disabled: loading, onChange: (event) => { setMode(event.target.value); setError(null); } },
          h("option", { value: "local" }, "OpenCode 2 本地服务"),
          h("option", { value: "go" }, "OpenCode Go API Key"))),
      local && h("p", { className: "gqc-quota-muted" }, "在已连接 Console 的 OpenCode 中启动本地服务。",
        h("code", { className: "gqc-service-command" }, "opencode serve --hostname 127.0.0.1 --port 4096")),
      teamBilling && h("p", { className: "gqc-quota-muted" }, "在 xAI Console 获取 Team ID 和有账单读取权限的 Management API Key。"),
      teamBilling && h("label", { className: "gqc-service-field" }, "Team ID",
        h("input", { name: "team", type: "text", maxLength: 128, required: true, spellCheck: false, disabled: loading })),
      regional && h("label", { className: "gqc-service-field" }, "套餐区域",
        h("select", { name: "region", disabled: loading },
          h("option", { value: "cn" }, "智谱开放平台（中国区）"),
          h("option", { value: "global" }, "Z.AI（国际版）"))),
      h("label", { className: "gqc-service-field" }, local ? "服务密码（如已启用）" : teamBilling ? "Management API Key" : "套餐 API Key",
        h("input", { key: mode, name: "secret", type: "password", maxLength: 2048, required: !local,
          autoComplete: "off", disabled: loading })),
      error && h("p", { role: "alert", className: "gqc-quota-message" }, error),
      h("div", { className: "gqc-service-actions" },
        h("span", { className: "gqc-quota-muted" }, "凭据仅在本次运行中使用"),
        h("button", { type: "submit", className: "gqc-service-button is-primary", disabled: loading }, "连接并查询"),
      ),
    );
    if (!channel) return form;
    return h("div", { className: "gqc-quota-stack" },
      h("button", { type: "button", className: "gqc-service-button is-primary", disabled: loading,
        onClick: () => void connectService(id, { mode: "channel", detected: true }) }, "使用 CC GUI 已配置的渠道"),
      h("details", null, h("summary", null, openCode ? "其他连接方式" : "手动输入套餐 API Key"), form),
    );
  }

  function ServiceDetail({ id, data, loading, connected, config }) {
    const service = services[id];
    if (!service.connect) return service.render(data, config);
    const connection = connections.get(id);
    const fallback = connected && data?.error && connection?.detected;
    return h("div", { className: "gqc-quota-stack", "aria-busy": loading },
      id === "grok" && h("p", { className: "gqc-quota-muted" }, "这里显示 xAI API 团队额度。个人订阅可在「管理展示」中选择 Grok 订阅。"),
      (fallback || !connected) && h(ConnectService, { id, loading }),
      connected && !data && loading && h("p", { className: "gqc-quota-muted", role: "status" }, "正在查询…"),
      connected && data?.error && h("p", { role: "alert", className: "gqc-quota-message" }, data.error),
      connected && data?.refreshError && h("p", { role: "status", className: "gqc-quota-message" }, "刷新失败，保留上次数据。 " + data.refreshError),
      connected && data && !data.error && service.render(data, config),
      connected && !fallback && h("div", { className: "gqc-service-actions" },
        h("button", { type: "button", className: "gqc-service-button", onClick: () => {
          if (service.autoLocal) probeOpenCode = false;
          disconnectService(id);
          notifySubscribers();
        } }, data?.error ? "重新连接" : "断开连接")),
    );
  }

  function RefreshButton({ busy, disabled, label, action }) {
    const [feedback, setFeedback] = useState(null);
    const runningTimer = useRef(null);
    const alive = useRef(true);
    useEffect(() => {
      alive.current = true;
      return () => {
        alive.current = false;
        clearTimeout(runningTimer.current);
      };
    }, []);

    async function refresh() {
      clearTimeout(runningTimer.current);
      setFeedback("running");
      const start = Date.now();
      const ok = await action();
      if (!alive.current) return;
      runningTimer.current = setTimeout(() => {
        setFeedback(ok ? "done" : null);
        if (ok) runningTimer.current = setTimeout(() => setFeedback(null), 900);
      }, Math.max(0, 600 - (Date.now() - start)));
    }

    const running = busy || feedback === "running";
    return h("button", { type: "button", className: "gqc-icon-button", disabled: disabled || running,
      title: feedback === "done" && !running ? "已刷新" : label, "aria-label": label, onClick: refresh },
      feedback === "done" && !running
        ? h("span", { className: "gqc-refresh-done", "aria-hidden": true }, "✓")
        : h(RefreshIcon, { spinning: running, size: 13 }),
    );
  }

  function QuotaPopover({ state, initialService, onClose }) {
    const { data, loading, usageLoading, pendingIds, connectedIds, visibleServices, preferredService, config, initialized } = state;
    const [viewMode, setViewMode] = useState("quota");
    const [managing, setManaging] = useState(false);
    const [usageRange, setUsageRange] = useState("today");
    const [selectedUsageProvider, setSelectedUsageProvider] = useState("全部");
    const tabGroupId = useId();
    const selectedTab = useRef(null);
    const manageButton = useRef(null);
    const forceFocusManage = useRef(false);
    const selectedId = resolveService(visibleServices, preferredService, initialService);
    const service = selectedId ? services[selectedId] : null;
    const modelData = selectedId ? data?.[selectedId] : null;
    const serviceLoading = pendingIds.includes(selectedId);
    const interval = autoRefreshMinutes();

    function finishManage() {
      forceFocusManage.current = true;
      setManaging(false);
    }

    useEffect(() => { (selectedTab.current ?? manageButton.current)?.focus(); }, []);
    useEffect(() => {
      if (!managing && forceFocusManage.current) {
        forceFocusManage.current = false;
        manageButton.current?.focus();
      }
    }, [managing]);
    useEffect(() => {
      function onEscape(event) {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (managing) finishManage();
        else onClose();
      }
      window.addEventListener("keydown", onEscape);
      return () => window.removeEventListener("keydown", onEscape);
    }, [managing, onClose]);

    function onTabKeyDown(event) {
      const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')];
      const index = tabs.indexOf(event.target);
      if (index === -1) return;
      const last = tabs.length - 1;
      const next = {
        ArrowLeft: index === 0 ? last : index - 1,
        ArrowRight: index === last ? 0 : index + 1,
        Home: 0,
        End: last,
      }[event.key];
      if (!Number.isInteger(next)) return;
      event.preventDefault();
      const nextId = visibleServices[next];
      chooseService(nextId);
      probeLocalService(nextId);
      tabs[next].focus();
    }

    return h("div", null,
      h("div", { className: "gqc-popover-backdrop", onClick: (event) => { event.stopPropagation(); onClose(); } }),
      h("div", { className: "gqc-popover " + (viewMode === "usage" ? "is-usage" : "is-quota"),
        role: "dialog", "aria-label": managing ? "管理展示" : "AI 配额与用量", onClick: (event) => event.stopPropagation() },
        h("div", { className: "gqc-quota-header" },
          h("strong", null, managing ? "管理展示" : viewMode === "usage" ? "AI 使用与成本" : "AI 配额"),
          h("div", { className: "gqc-quota-tools" },
            !managing && h("div", { className: "gqc-header-switcher", role: "group", "aria-label": "看板类型" },
              [["quota", "配额"], ["usage", "用量"]].map(([mode, label]) => h("button", { key: mode, type: "button",
                className: "gqc-header-switch-btn" + (viewMode === mode ? " is-active" : ""),
                "aria-pressed": viewMode === mode, onClick: () => setViewMode(mode),
              }, label)),
            ),
            !managing && (viewMode === "usage"
              ? h(RefreshButton, { key: "usage", busy: usageLoading, label: "刷新用量统计", action: fetchUsageOnly })
              : h(RefreshButton, { key: selectedId, busy: serviceLoading, label: "刷新当前服务",
                disabled: !selectedId || (service.connect && !connectedIds.includes(selectedId)), action: () => fetchProvider(selectedId) })),
            h("button", { type: "button", className: "gqc-icon-button", title: "关闭", "aria-label": "关闭看板", onClick: onClose },
              h(CloseIcon, { size: 13 })),
          ),
        ),
        managing ? h(ManageServices, { visibleIds: visibleServices, onClose: finishManage })
          : viewMode === "usage"
            ? renderUsageStatsView(data?.usageStats, loading, usageLoading, config, usageRange, setUsageRange,
                () => void fetchUsageOnly(), selectedUsageProvider, setSelectedUsageProvider)
            : h("div", { className: "gqc-quota-stack" },
                service && h("div", { className: "gqc-service-tabs", role: "tablist", "aria-label": "配额服务",
                  onKeyDown: onTabKeyDown }, visibleServices.map((id) => {
                  const item = services[id];
                  const active = id === selectedId;
                  return h("button", { key: id, id: tabGroupId + "-tab-" + id, type: "button", role: "tab",
                    className: "gqc-tab-btn" + (active ? " is-active" : ""),
                    "aria-selected": active, "aria-controls": tabGroupId + "-panel-" + id,
                    title: item.name, "aria-label": item.name, tabIndex: active ? 0 : -1,
                    ref: active ? selectedTab : null, onClick: () => { chooseService(id); probeLocalService(id); },
                  }, h("span", { className: "gqc-tab-icon", "aria-hidden": true }, h(item.icon, { size: 12 })),
                    h("span", { className: "gqc-tab-label" }, item.tabLabel ?? item.name));
                })),
                h("div", { className: "gqc-service-toolbar" },
                  service && h("div", { className: "gqc-quota-refresh-line", role: "status" },
                    h("span", null, modelData?.fetchedAt ? "更新于 " + formatRefreshTime(modelData.fetchedAt) : "尚未更新"),
                    h("span", null, serviceLoading ? "刷新中…" : service.connect && (!connectedIds.includes(selectedId) || modelData?.error) ? "等待连接" :
                      service.manualOnly || connections.get(selectedId)?.mode === "channel" ? "手动刷新" : interval > 0 ? "每 " + interval + " 分钟刷新" : "自动刷新已关闭"),
                  ),
                  h("button", { ref: manageButton, type: "button", className: "gqc-service-button",
                    onClick: () => setManaging(true), disabled: !initialized }, "管理展示"),
                ),
                service ? visibleServices.map((id) => h("div", {
                  key: id, id: tabGroupId + "-panel-" + id, role: "tabpanel",
                  "aria-labelledby": tabGroupId + "-tab-" + id, hidden: id !== selectedId, tabIndex: 0,
                }, id === selectedId && h(ServiceDetail, {
                  id, data: modelData, loading: serviceLoading, config, connected: connectedIds.includes(id),
                }))) : h("div", { className: "gqc-quota-empty" },
                  h("strong", null, initialized ? "还没有展示的服务" : "正在读取展示设置…"),
                  initialized && h("span", { className: "gqc-quota-muted" }, "通过「管理展示」选择要关注的服务。"),
                ),
              ),
      ),
    );
  }

  function chooseService(id) {
    preferredService = id;
    notifySubscribers();
  }

  function quotaSummary(id, data, mode) {
    if (!data || data.error) return null;
    if (id === "grok") {
      if (Number.isFinite(data.balance)) return { label: "余额", display: formatUsd(data.balance) };
      if (Number.isFinite(data.postpaidLimit)) return { label: "月限", display: formatUsd(data.postpaidLimit) };
      return null;
    }
    if (Array.isArray(data.windows)) {
      const meter = data.windows.find((item) => item.id === "weekly" || item.id === "seven_day") ?? data.windows[0];
      return meter ? { label: meter.shortLabel, display: Math.round(meter.remaining) + "%", percent: meter.remaining } : null;
    }
    if (id === "codebuddy") {
      if (data.limitNum === -1) return { label: "积分", display: "不限" };
      if (!Number.isFinite(data.remainingPercent)) return null;
      return { label: "积分", display: data.remainingPercent + "%", percent: data.remainingPercent };
    }
    const weekly = data.weekly ?? data.h5;
    if (!weekly) return null;
    if (mode !== "weekly_only" && data.weekly && data.h5 && mode !== "all") {
      return { label: "7D", display: weekly.remaining + "%", secondary: data.h5.remaining + "%",
        percent: Math.min(weekly.remaining, data.h5.remaining) };
    }
    return { label: data.weekly ? "7D" : "5H", display: weekly.remaining + "%", percent: weekly.remaining };
  }

  function StatusBarChip() {
    const state = useQuotaState();
    const [showPopover, setShowPopover] = useState(false);
    const chipRef = useRef(null);
    const closePopover = useCallback(() => {
      setShowPopover(false);
      chipRef.current?.focus();
    }, []);
    if (ctx.host?.isWeb || !state.initialized || state.config.showStatusBarChip === false) return null;

    const { data, activeEngine, visibleServices, config } = state;
    const mode = typeof config.statusBarDisplay === "string" ? config.statusBarDisplay : "auto";
    const fixedService = mode.endsWith("_only") ? mode.slice(0, -5) : null;
    const idsWithData = visibleServices.filter((id) => quotaSummary(id, data?.[id], mode));
    const initialService = resolveService(visibleServices, fixedService, serviceForEngine(activeEngine), ...idsWithData);
    const overview = mode === "all" || mode === "weekly_only";
    const candidates = overview ? idsWithData : [initialService].filter(Boolean);
    const summaries = candidates.slice(0, 2).map((id) => {
      const summary = quotaSummary(id, data?.[id], mode);
      return summary ? { id, ...summary } : null;
    }).filter(Boolean);
    const names = summaries.map(({ id, label, display, secondary }) =>
      services[id].name + " " + label + " " + display + (secondary ? "，5H " + secondary : ""));
    if (candidates.some((id) => data?.[id]?.refreshError)) names.push("显示上次成功数据");
    const title = [...names, "打开 AI 配额与用量"].join(" · ");
    const low = candidates.some((id) => {
      const percent = quotaSummary(id, data?.[id], mode)?.percent;
      return Number.isFinite(percent) && percent < (config.warningThreshold ?? 20);
    });

    return h("div", { className: "gqc-status-anchor" },
      h("button", { ref: chipRef, type: "button", title, "aria-label": title, "aria-haspopup": "dialog",
        "aria-expanded": showPopover, className: "gqc-status-chip" + (showPopover ? " is-active" : "") + (low ? " is-low" : ""),
        onClick: (event) => {
          event.stopPropagation();
          if (!showPopover) probeLocalService(resolveService(visibleServices, state.preferredService, initialService));
          setShowPopover(!showPopover);
        } },
        summaries.length === 0 && h("span", { className: "gqc-chip-group" },
          h(initialService ? services[initialService].icon : QuotaIcon, { size: 12 }),
          initialService ? services[initialService].name : "AI 配额",
        ),
        summaries.map(({ id, label, display, secondary }) => h("span", { key: id, className: "gqc-chip-group" },
          h(services[id].icon, { size: 12 }),
          h("span", { className: "gqc-chip-label" }, label),
          h("span", { className: "gqc-chip-val" }, display),
          secondary && h("span", { className: "gqc-chip-label" }, "5H"),
          secondary && h("span", { className: "gqc-chip-val" }, secondary),
        )),
        candidates.length > 2 && h("span", { className: "gqc-chip-label" }, "+" + (candidates.length - 2)),
      ),
      showPopover && h(QuotaPopover, { state, initialService, onClose: closePopover }),
    );
  }

  // ── 注册扩展点 ──────────────────────────────────────────────────────────────
  ctx.ui.registerStatusBarItem({
    component: StatusBarChip,
    zone: "end",
  });

  ctx.ui.registerCommand({
    key: "ai-quota:refresh",
    title: () => "AI 配额: 刷新用量与积分",
    keywords: () => ["gemini", "codex", "codebuddy", "opencode", "grok", "chatgpt", "quota", "credits", "积分", "周限", "额度", "用量"],
    run: () => {
      void fetchQuota(true);
    },
  });

  const unsubSession = ctx.events.on("session://activated", (payload) => {
    activeEngine = payload && typeof payload === "object" ? payload.engine : null;
    if (!config.statusBarDisplay || config.statusBarDisplay === "auto") {
      const id = serviceForEngine(activeEngine);
      if (visibleServices.includes(id)) preferredService = id;
    }
    notifySubscribers();
  });

  const configKeys = ["autoRefreshMinutes", "statusBarDisplay", "showStatusBarChip", "warningThreshold"];

  function autoRefreshMinutes() {
    const minutes = config.autoRefreshMinutes;
    return Number.isFinite(minutes) && minutes >= 0 && minutes <= 120 ? minutes : 30;
  }

  function restartAutoRefresh() {
    clearInterval(autoTimer);
    const interval = autoRefreshMinutes();
    if (!ctx.host?.isWeb && interval > 0) {
      autoTimer = setInterval(fetchQuota, interval * 60 * 1000);
    }
  }

  const configChanges = new Map();
  const unsubConfig = ctx.events.on("plugin-config://changed", (event) => {
    if (event?.pluginId !== ctx.pluginId || !configKeys.includes(event.key)) return;
    if (!initialized) configChanges.set(event.key, event.value);
    config = { ...config, [event.key]: event.value };
    if (initialized && event.key === "autoRefreshMinutes") restartAutoRefresh();
    notifySubscribers();
  });

  async function init() {
    const [cache, selection, legacyConfig, ...fields] = await Promise.allSettled(
      ["cached_quota", "visible_quota_services", "config", ...configKeys.map((key) => "config." + key)]
        .map((key) => ctx.storage.get(key)),
    );
    if (disposed) return;
    cachedData = cache.status === "fulfilled" && cache.value ? legacyCacheData(cache.value) : null;
    config = { ...(legacyConfig.status === "fulfilled" ? legacyConfig.value : null) };
    for (const [index, field] of fields.entries()) {
      if (field.status === "fulfilled" && field.value != null) config[configKeys[index]] = field.value;
    }
    config = { ...config, ...Object.fromEntries(configChanges) };
    configChanges.clear();
    visibleServices = normalizeVisibleServices(selection.status === "fulfilled" ? selection.value : undefined, knownServiceIds);
    initialized = true;
    notifySubscribers();
    restartAutoRefresh();
    if (autoRefreshMinutes() > 0) void fetchQuota();
  }

  void init();

  return () => {
    disposed = true;
    clearInterval(autoTimer);
    connections.clear();
    pending.clear();
    if (typeof unsubSession === "function") unsubSession();
    if (typeof unsubConfig === "function") unsubConfig();
    subscribers.clear();
  };
}
