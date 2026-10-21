/**
 * 页面内的所有浮层 UI：
 *   · 填充结果面板（高亮 + 汇总 + 一键撤销）
 *   · 选取输入框时的区域高亮框
 *   · 简历数据面板
 *   · 「这块是什么」区块选择面板
 *   · 「这个框填什么」字段选择面板
 *
 * 全部放在一个 Shadow DOM 里，避免和站点样式互相污染。
 * 浮层自身带 data-ra-ignore 属性，扫描时会跳过，不会把自己的输入框当成表单字段。
 *
 * 所有来自页面的字符串一律用 textContent 写入，绝不拼接进 innerHTML。
 */
(function (root) {
  'use strict';

  const RA = root.RA;

  const HOST_ID = 'ra-overlay-host';
  const MARKS = [];

  let shadowRoot = null;
  let highlightBox = null;
  /** 当前主题。宿主元素是懒创建的，创建时要带上这个值。 */
  let currentTheme = 'light';

  const Z = 2147483647;

  const CSS = `
    /* ═══════════ 设计变量 ═══════════ */
    /* 和弹窗、选项页共用同一套色板和尺度；面板用毛玻璃做层次 */

    :host {
      all: initial;
      pointer-events: none;

      /* 显式声明配色方案，别让 Chrome 按宿主的系统偏好去画滚动条和输入框 ——
         浅色主题 + 深色系统时，滚动条会变成一条深色杠 */
      color-scheme: light;

      /* 玻璃材质 —— 四层叠出来，不依赖背景。
         之前只调透明度是不行的：面板后面是白页，白玻璃叠白底永远是白的，
         物理上就看不出来。所以把「玻璃」当成一种有颜色的材料来画：
         ① 对角渐变：左上亮、右下暗 —— 读出「有一块倾斜的面」
         ② 斜向高光：左上角一道亮光 —— 光打在玻璃上
         ③ 细噪点：磨砂颗粒 —— 这层是「磨砂」和「半透明色块」的分水岭
         ④ 边缘高光：1px 白色内描边 —— 玻璃的厚度和切边 */
      --ra-glass:
        linear-gradient(
          112deg,
          rgba(255, 255, 255, .72) 0%,
          rgba(255, 255, 255, .12) 28%,
          rgba(255, 255, 255, 0) 48%
        ),
        linear-gradient(
          152deg,
          rgba(252, 253, 255, .88) 0%,
          rgba(232, 238, 250, .84) 50%,
          rgba(208, 218, 236, .82) 100%
        );
      --ra-grain: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23g)'/%3E%3C/svg%3E");
      --ra-grain-opacity: .08;
      --ra-glass-edge: rgba(255, 255, 255, .95);
      --ra-glass-rim: rgba(255, 255, 255, .45);
      --ra-glass-filter: blur(40px) saturate(180%) brightness(1.04);
      /* 自定义下拉箭头：原生三角在不同系统上长得差别太大 */
      --ra-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%2386868b' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      --ra-surface: #ffffff;
      --ra-surface-hover: #f0f0f2;
      /* 吸顶标题：半透明 + 自己一层 backdrop blur。
         滚动的字段从它底下经过时是被「磨」过的——这一处比什么都像毛玻璃，
         而且必须比面板本身更透，否则就是一块白条压在玻璃上 */
      --ra-plane: rgba(236, 241, 251, .78);
      --ra-plane-hover: rgba(226, 233, 248, .86);
      --ra-plane-filter: blur(16px) saturate(160%);
      /* 玻璃卡片里再叠一层的浅底 */
      --ra-card: rgba(255, 255, 255, .55);
      --ra-fill: rgba(120, 120, 128, .09);
      --ra-fill-strong: rgba(120, 120, 128, .14);
      --ra-fg: #1d1d1f;
      --ra-fg-muted: #6e6e73;
      --ra-fg-subtle: #86868b;
      --ra-border: rgba(0, 0, 0, .08);
      --ra-border-strong: rgba(0, 0, 0, .14);
      --ra-accent: #0071e3;
      --ra-accent-hover: #0077ed;
      --ra-accent-soft: rgba(0, 113, 227, .08);
      --ra-ok: #34c759;
      --ra-warn: #ff9500;
      --ra-bad: #ff3b30;
      --ra-radius: 22px;
      --ra-radius-sm: 13px;
      --ra-shadow: 0 2px 8px rgba(0, 0, 0, .06), 0 16px 40px rgba(0, 0, 0, .12);
      --ra-ease: cubic-bezier(.32, .72, 0, 1);
      --ra-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC",
                 "Microsoft YaHei", "Helvetica Neue", sans-serif;
    }

    :host([data-ra-theme="dark"]) {
      color-scheme: dark;
      /* 深色玻璃：同一套四层，只是亮度方向反过来 */
      --ra-glass:
        linear-gradient(
          112deg,
          rgba(255, 255, 255, .13) 0%,
          rgba(255, 255, 255, .03) 28%,
          rgba(255, 255, 255, 0) 48%
        ),
        linear-gradient(
          152deg,
          rgba(80, 84, 96, .86) 0%,
          rgba(46, 49, 59, .84) 50%,
          rgba(26, 28, 35, .82) 100%
        );
      --ra-grain-opacity: .12;
      --ra-glass-edge: rgba(255, 255, 255, .22);
      --ra-glass-rim: rgba(255, 255, 255, .07);
      --ra-glass-filter: blur(40px) saturate(165%) brightness(.95);
      --ra-chevron: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23a1a1a6' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      --ra-surface: #1c1c1e;
      --ra-surface-hover: #2c2c2e;
      --ra-plane: rgba(44, 47, 57, .78);
      --ra-plane-hover: rgba(58, 62, 74, .86);
      --ra-plane-filter: blur(16px) saturate(150%);
      --ra-card: rgba(255, 255, 255, .07);
      --ra-fill: rgba(120, 120, 128, .24);
      --ra-fill-strong: rgba(120, 120, 128, .36);
      /* 深色主题下文字一律纯白：灰字压在深色玻璃上对比太低 */
      --ra-fg: #ffffff;
      --ra-fg-muted: #ffffff;
      --ra-fg-subtle: #ffffff;
      --ra-border: rgba(255, 255, 255, .12);
      --ra-border-strong: rgba(255, 255, 255, .2);
      --ra-accent: #0a84ff;
      --ra-accent-hover: #409cff;
      --ra-accent-soft: rgba(10, 132, 255, .16);
      --ra-ok: #30d158;
      --ra-warn: #ff9f0a;
      --ra-bad: #ff453a;
      --ra-shadow: 0 2px 12px rgba(0, 0, 0, .5), 0 20px 48px rgba(0, 0, 0, .6);
    }

    * { box-sizing: border-box; }

    /* ═══════════ 填充结果面板 ═══════════ */

    .wrap {
      position: fixed; right: 18px; bottom: 18px; z-index: ${Z};
      width: 360px; max-height: 62vh; display: flex; flex-direction: column;
      font: 13px/1.5 var(--ra-font);
      color: var(--ra-fg);
      background: var(--ra-glass);
      -webkit-backdrop-filter: var(--ra-glass-filter);
      backdrop-filter: var(--ra-glass-filter);
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius);
      /* 顶缘强高光 + 一圈弱内描边 + 外部投影，玻璃才有厚度 */
      box-shadow:
        inset 0 1px 0 var(--ra-glass-edge),
        inset 0 0 0 1px var(--ra-glass-rim),
        var(--ra-shadow);
      overflow: hidden; pointer-events: auto;
      animation: ra-pop .22s var(--ra-ease);
    }
    @keyframes ra-pop {
      from { opacity: 0; transform: translateY(10px) scale(.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    /* 磨砂颗粒层：铺在内容之上但不吃点击。
       z-index 要高于吸顶标题的 2，否则滚动时标题会从颗粒里「穿出来」，
       整块面板立刻穿帮成「普通白底 + 一层贴图」 */
    .wrap::after,
    .datapanel::after {
      content: ""; position: absolute; inset: 0; z-index: 6;
      background-image: var(--ra-grain); background-size: 160px 160px;
      opacity: var(--ra-grain-opacity);
      border-radius: inherit;
      pointer-events: none;
    }

    .wrap header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 16px 12px;
      border-bottom: 1px solid var(--ra-border);
      font-weight: 600; font-size: 13.5px; letter-spacing: -.015em;
      flex: 0 0 auto;
    }
    .wrap header .close {
      border: 0; background: transparent; cursor: pointer; font-size: 19px;
      line-height: 1; color: var(--ra-fg-subtle); padding: 2px 7px;
      border-radius: 7px;
      transition: background .2s var(--ra-ease), color .2s var(--ra-ease);
    }
    .wrap header .close:hover { background: var(--ra-fill); color: var(--ra-fg); }

    .wrap .stats {
      display: flex; gap: 16px; padding: 10px 16px;
      flex: 0 0 auto; font-size: 12px; color: var(--ra-fg-muted);
    }
    .wrap .stats b {
      font-weight: 600; font-variant-numeric: tabular-nums; color: var(--ra-fg);
    }
    .wrap .stats .hi b { color: var(--ra-ok); }
    .wrap .stats .lo b { color: var(--ra-warn); }
    .wrap .stats .bad b { color: var(--ra-bad); }
    .wrap .stats .sk b { color: var(--ra-fg-subtle); }

    ul.rows { list-style: none; margin: 0; padding: 0; overflow-y: auto; flex: 1 1 auto; }
    ul.rows li {
      display: grid; grid-template-columns: 82px minmax(0, 1fr) auto;
      gap: 12px; align-items: baseline;
      padding: 7px 16px; border-top: 1px solid var(--ra-border); font-size: 12px;
    }
    ul.rows li .k {
      color: var(--ra-fg-muted);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    ul.rows li .v { min-width: 0; word-break: break-all; }
    ul.rows li.low .v { color: var(--ra-warn); }
    ul.rows li.fail .v { color: var(--ra-bad); }
    ul.rows li .tag { font-size: 11px; color: var(--ra-warn); white-space: nowrap; }

    .wrap footer {
      display: flex; flex-wrap: wrap; gap: 8px;
      padding: 12px 16px; flex: 0 0 auto;
      border-top: 1px solid var(--ra-border);
    }

    button.act {
      flex: 1 1 auto; padding: 8px 12px; border-radius: 999px;
      cursor: pointer; border: 0; background: var(--ra-fill);
      color: var(--ra-fg); font: inherit; font-size: 12px; font-weight: 500;
      transition: background .2s var(--ra-ease), transform .18s var(--ra-ease);
    }
    button.act:hover:not(:disabled) { background: var(--ra-fill-strong); }
    button.act:active:not(:disabled) { transform: scale(.97); }
    button.act:focus-visible { outline: 2px solid var(--ra-accent); outline-offset: 2px; }
    button.act:disabled { opacity: .45; cursor: default; }
    button.danger { color: var(--ra-bad); }
    button.danger:hover:not(:disabled) { background: rgba(255, 59, 48, .1); }

    /* 「完成」独占一行：核对完收工是最后一步，给足点击面积 */
    button.act.done {
      flex: 1 1 100%;
      padding: 9px 18px;
      background: var(--ra-accent);
      color: #fff;
      font-weight: 600;
      box-shadow: 0 1px 3px rgba(0, 113, 227, .24);
    }
    button.act.done:hover:not(:disabled) {
      background: var(--ra-accent-hover);
      box-shadow: 0 3px 14px rgba(0, 113, 227, .3);
    }

    .wrap .note { padding: 0 16px 12px; font-size: 11px; color: var(--ra-fg-subtle); line-height: 1.6; }

    /* ═══════════ 选取输入框时的锚点高亮 ═══════════ */

    .highlight {
      position: fixed; z-index: ${Z}; pointer-events: none; display: none;
      border: 2px solid var(--ra-accent);
      background: var(--ra-accent-soft);
      border-radius: 7px;
      box-shadow: 0 0 0 4px rgba(0, 113, 227, .12);
      transition: left .06s linear, top .06s linear,
                  width .06s linear, height .06s linear;
    }

    .hintbar {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      z-index: ${Z}; padding: 10px 20px; border-radius: 999px;
      background: #1d1d1f;
      color: #f5f5f7;
      font: 12.5px/1.4 var(--ra-font);
      box-shadow: 0 4px 20px rgba(0, 0, 0, .24);
      pointer-events: none; white-space: nowrap;
    }
    .hintbar kbd {
      background: rgba(255, 255, 255, .18); padding: 1px 7px; border-radius: 5px;
      font-family: inherit; font-size: 11.5px; font-weight: 600;
    }

    /* ═══════════ 简历数据面板 ═══════════ */

    .datapanel {
      /* 四边留出间距，玻璃才是一块「放上去的板」而不是贴边的白条。
         圆角配合外投影，边缘才有厚度 */
      position: fixed; right: 12px; top: 12px; bottom: 12px;
      /* 用百分比而不是 100vw：vw 含经典滚动条宽度，窄窗口下会顶出屏幕 */
      width: 560px; max-width: calc(100% - 24px); z-index: ${Z};
      display: flex; flex-direction: column;
      background: var(--ra-glass);
      -webkit-backdrop-filter: var(--ra-glass-filter);
      backdrop-filter: var(--ra-glass-filter);
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius);
      /* 顶缘强高光 + 一圈弱内描边 + 外投影 */
      box-shadow:
        inset 0 1px 0 var(--ra-glass-edge),
        inset 0 0 0 1px var(--ra-glass-rim),
        var(--ra-shadow);
      /* 圆角要真的裁掉内容，否则滚动的字段会从圆角处露出来 */
      overflow: hidden;
      pointer-events: auto;
      font: 13px/1.5 var(--ra-font);
      color: var(--ra-fg);
      animation: ra-slide .26s var(--ra-ease);
    }
    @keyframes ra-slide {
      from { transform: translateX(24px); opacity: .4; }
      to { transform: translateX(0); opacity: 1; }
    }

    .dp-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 18px 20px 14px;
      border-bottom: 1px solid var(--ra-border);
      font-weight: 600; font-size: 16px; letter-spacing: -.02em;
      flex: 0 0 auto;
    }
    .dp-head button {
      border: 0; background: transparent; cursor: pointer; font-size: 20px;
      line-height: 1; color: var(--ra-fg-subtle); padding: 2px 8px;
      border-radius: 8px;
      transition: background .2s var(--ra-ease), color .2s var(--ra-ease);
    }
    .dp-head button:hover { background: var(--ra-fill); color: var(--ra-fg); }

    .dp-status {
      padding: 9px 20px; font-size: 11.5px; line-height: 1.55;
      color: var(--ra-fg-muted);
      border-bottom: 1px solid var(--ra-border); flex: 0 0 auto;
      transition: background .24s var(--ra-ease), color .24s var(--ra-ease);
    }
    .dp-status.armed {
      background: var(--ra-accent-soft);
      color: var(--ra-accent);
      font-weight: 600;
    }
    .dp-status button {
      margin-left: 8px; border: 0; background: transparent; cursor: pointer;
      color: inherit; font: inherit; text-decoration: underline;
      text-underline-offset: 2px; padding: 0; opacity: .85;
    }
    .dp-status button:hover { opacity: 1; }

    .dp-search { padding: 12px 20px; border-bottom: 1px solid var(--ra-border); flex: 0 0 auto; }
    .dp-search input {
      width: 100%; padding: 8px 12px;
      border: 0; border-radius: var(--ra-radius-sm);
      background: var(--ra-fill); color: var(--ra-fg);
      font: inherit; font-size: 12.5px;
      transition: background .2s var(--ra-ease), box-shadow .2s var(--ra-ease);
    }
    .dp-search input::placeholder { color: var(--ra-fg-subtle); }
    .dp-search input:focus {
      outline: none; background: var(--ra-surface);
      box-shadow: 0 0 0 3px rgba(0, 113, 227, .18), inset 0 0 0 1px var(--ra-accent);
    }

    .dp-body { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; }

    /* ── 模块 ── */
    .dp-mod { border-bottom: 1px solid var(--ra-border); }

    .dp-modhead {
      width: 100%; display: flex; align-items: center; gap: 10px;
      padding: 12px 20px; border: 0; border-bottom: 1px solid transparent;
      /* 吸顶标题：半透明磨砂，滚动的内容从底下经过时被它磨掉细节。
         必须保留一点不透明度，否则字段行会清晰地从标题底下穿过去 */
      background: var(--ra-plane);
      -webkit-backdrop-filter: var(--ra-plane-filter);
      backdrop-filter: var(--ra-plane-filter);
      font: inherit; font-size: 13.5px; font-weight: 600; color: var(--ra-fg);
      letter-spacing: -.015em;
      cursor: pointer; text-align: left;
      position: sticky; top: 0; z-index: 2;
      transition: background .2s var(--ra-ease);
    }
    .dp-modhead:hover { background: var(--ra-plane-hover); }
    .dp-mod.open .dp-modhead { border-bottom-color: var(--ra-border); }

    .dp-chev {
      flex: 0 0 auto; width: 12px; font-size: 10px; color: var(--ra-fg-subtle);
      transition: color .2s var(--ra-ease);
    }
    .dp-modhead:hover .dp-chev { color: var(--ra-fg-muted); }

    .dp-modname { flex: 1 1 auto; min-width: 0; }

    .dp-count {
      flex: 0 0 auto; font-size: 11px; font-weight: 500;
      color: var(--ra-fg-muted); background: var(--ra-fill);
      padding: 2px 9px; border-radius: 999px;
      font-variant-numeric: tabular-nums;
    }

    /* 模块内容区是网格：短字段两两并排，长字段跨整行 */
    .dp-modbody {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(224px, 1fr));
      column-gap: 8px; row-gap: 0; align-items: start;
      padding: 6px 20px 14px 34px;
    }

    .dp-entry {
      grid-column: 1 / -1;
      padding: 11px 8px 4px;
      font-size: 11px; font-weight: 600; letter-spacing: .01em;
      color: var(--ra-fg-subtle);
      border-top: 1px solid var(--ra-border);
    }
    .dp-entry:first-child { border-top: 0; padding-top: 6px; }

    /* 标签列宽度必须统一：宽行和普通行用同一个值，
       否则同一块里的值会一上一下错开，看着很乱 */
    .dp-row {
      display: grid; grid-template-columns: 76px minmax(0, 1fr) auto;
      align-items: center; gap: 8px;
      padding: 5px 8px; min-width: 0;
      cursor: pointer; border-radius: 8px;
      transition: background .16s var(--ra-ease);
    }
    .dp-row:hover { background: var(--ra-fill); }
    .dp-row.wide { grid-column: 1 / -1; }

    .dp-k {
      color: var(--ra-fg-muted); font-size: 12px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .dp-v {
      font-size: 12.5px; color: var(--ra-fg); min-width: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      letter-spacing: -.005em;
    }
    .dp-c {
      border: 0; background: transparent;
      color: var(--ra-accent); font: inherit; font-size: 11px; font-weight: 500;
      padding: 2px 8px; border-radius: 999px; cursor: pointer;
      white-space: nowrap; opacity: 0;
      transition: opacity .18s var(--ra-ease), background .18s var(--ra-ease);
    }
    .dp-row:hover .dp-c { opacity: 1; }
    .dp-c:hover { background: var(--ra-accent-soft); }
    /* 触屏或键盘操作时复制按钮常驻，否则根本点不到 */
    @media (hover: none) { .dp-c { opacity: 1; } }
    .dp-c:focus-visible { opacity: 1; outline: 2px solid var(--ra-accent); outline-offset: 1px; }

    .dp-empty {
      padding: 40px 20px; color: var(--ra-fg-subtle);
      font-size: 12.5px; text-align: center; line-height: 1.8;
    }

    .dp-foot {
      display: flex; gap: 8px; padding: 14px 20px; flex: 0 0 auto;
      border-top: 1px solid var(--ra-border);
    }
    .dp-foot button {
      flex: 1 1 auto; padding: 9px 12px; border-radius: 999px;
      cursor: pointer; border: 0; background: var(--ra-fill);
      color: var(--ra-fg); font: inherit; font-size: 12px; font-weight: 500;
      transition: background .2s var(--ra-ease), transform .18s var(--ra-ease);
    }
    .dp-foot button:hover:not(:disabled) { background: var(--ra-fill-strong); }
    .dp-foot button:active:not(:disabled) { transform: scale(.97); }
    .dp-foot button:focus-visible { outline: 2px solid var(--ra-accent); outline-offset: 2px; }
    .dp-foot button:disabled { opacity: .45; cursor: default; }

    /* ═══════════ 轻提示 ═══════════ */

    .toast {
      position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%);
      z-index: ${Z}; padding: 11px 22px; border-radius: 999px;
      background: #1d1d1f;
      color: #f5f5f7;
      font: 12.5px/1.4 var(--ra-font);
      box-shadow: 0 6px 24px rgba(0, 0, 0, .26);
      pointer-events: none;
      animation: ra-toast .2s var(--ra-ease);
    }
    @keyframes ra-toast {
      from { opacity: 0; transform: translate(-50%, 10px); }
      to { opacity: 1; transform: translate(-50%, 0); }
    }

    /* ═══════════ 页面内的悬浮入口 ═══════════ */

    /* 右下角，离边缘留出 32px。圆形。
       结果面板和数据面板打开时它会被盖住，那种情况下由 JS 直接隐藏，
       否则会从半透明的玻璃底下透出来 */
    .fab {
      position: fixed; right: 72px; bottom: 72px; z-index: ${Z};
      width: 52px; height: 52px; padding: 0;
      display: grid; place-items: center;
      border: 1px solid var(--ra-glass-rim);
      border-radius: 50%;
      background: var(--ra-glass);
      -webkit-backdrop-filter: var(--ra-glass-filter);
      backdrop-filter: var(--ra-glass-filter);
      box-shadow: inset 0 1px 0 var(--ra-glass-edge), var(--ra-shadow);
      cursor: pointer; pointer-events: auto;
      transition: transform .18s var(--ra-ease), box-shadow .18s var(--ra-ease);
      animation: ra-fab-in .3s var(--ra-ease);
    }
    .fab:hover {
      transform: translateY(-2px);
      box-shadow: inset 0 1px 0 var(--ra-glass-edge),
                  0 8px 24px rgba(0, 0, 0, .18);
    }
    .fab:active { transform: scale(.94); }
    .fab:focus-visible { outline: 2px solid var(--ra-accent); outline-offset: 2px; }
    /* UA 的 [hidden] { display: none } 优先级低于 .fab { display: grid }，
       不补这一条 hidden 属性就压不住 */
    .fab[hidden] { display: none; }
    .fab img {
      width: 32px; height: 32px; display: block; border-radius: 9px;
      /* 图片默认可被浏览器原生拖拽，按在图标上会把图拖出去而不是拖按钮 */
      -webkit-user-drag: none;
      user-select: none;
    }
    /* 拿不到图标 URL 时（比如测试环境）退化成文字 */
    .fab .txt {
      font: 600 15px/1 var(--ra-font);
      color: var(--ra-accent);
      letter-spacing: .02em;
    }
    @keyframes ra-fab-in {
      from { opacity: 0; transform: translateY(8px) scale(.9); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    /* ═══════════ 悬浮首页卡片 ═══════════ */
    /* 点悬浮按钮弹出，内容对齐弹窗首页：摘要 + 三个动作 + 编辑入口。
       放在按钮正上方，右边缘和按钮对齐 */

    .home {
      position: fixed; right: 72px; bottom: 138px; z-index: ${Z};
      width: 320px; max-width: calc(100vw - 32px);
      max-height: calc(100vh - 24px); overflow-y: auto; overscroll-behavior: contain;
      display: flex; flex-direction: column;
      background: var(--ra-glass);
      -webkit-backdrop-filter: var(--ra-glass-filter);
      backdrop-filter: var(--ra-glass-filter);
      border: 1px solid var(--ra-border);
      border-radius: var(--ra-radius);
      box-shadow: inset 0 1px 0 var(--ra-glass-edge),
                  inset 0 0 0 1px var(--ra-glass-rim),
                  var(--ra-shadow);
      font: 13px/1.5 var(--ra-font);
      color: var(--ra-fg);
      pointer-events: auto;
      animation: ra-pop .22s var(--ra-ease);
    }

    .hm-head {
      display: flex; align-items: center; gap: 9px;
      padding: 13px 13px 10px;
    }
    /* 只有数据面板的标题栏是拖动手柄；
       首页卡片固定在悬浮按钮上方，只能跟着按钮走 */
    .dp-head {
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
      /* 触屏上别让浏览器把拖动当成滚动手势 */
      touch-action: none;
    }
    .dp-head:active { cursor: grabbing; }
    .hm-head { user-select: none; -webkit-user-select: none; }
    .hm-head img {
      width: 26px; height: 26px; display: block; border-radius: 7px;
      -webkit-user-drag: none;
      user-select: none;
    }
    .hm-title {
      flex: 1 1 auto; font-size: 14px; font-weight: 600; letter-spacing: -.015em;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /* 主题下拉：和弹窗右上角那个同一套做法，尽量窄 */
    .hm-theme {
      flex: 0 0 auto;
      max-width: 88px;
      appearance: none;
      -webkit-appearance: none;
      padding: 3px 22px 3px 7px;
      border: 0;
      border-radius: 8px;
      background-color: var(--ra-fill);
      background-image: var(--ra-chevron);
      background-repeat: no-repeat;
      background-position: right 6px center;
      color: var(--ra-fg-muted);
      font: inherit;
      font-size: 11px;
      cursor: pointer;
      transition: background-color .2s var(--ra-ease), color .2s var(--ra-ease);
    }

    /* 当前简历：卡片里直接切，不用回设置页 */
    .hm-resume {
      display: flex; align-items: center; gap: 8px;
      margin: 0 13px 10px;
    }
    .hm-resume-label {
      flex: 0 0 auto;
      font-size: 11.5px;
      color: var(--ra-fg-subtle);
    }
    .hm-resume-select {
      flex: 1 1 auto;
      min-width: 0;
      appearance: none;
      -webkit-appearance: none;
      padding: 4px 24px 4px 9px;
      border: 0;
      border-radius: 8px;
      background-color: var(--ra-fill);
      background-image: var(--ra-chevron);
      background-repeat: no-repeat;
      background-position: right 7px center;
      color: var(--ra-fg);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      transition: background-color .2s var(--ra-ease);
    }
    .hm-resume-select:hover { background-color: var(--ra-fill-strong); }
    .hm-resume-select:focus-visible { outline: 2px solid var(--ra-accent); outline-offset: 2px; }

    /* 自定义下拉：原生列表是系统画的，换成自绘的 */
    .ui-select-trigger {
      display: inline-flex; align-items: center; justify-content: space-between;
      gap: 6px; min-width: 0; padding-right: 8px;
      text-align: left; font: inherit; font-size: 12px;
      background-image: none; cursor: pointer;
    }
    .ui-select-label {
      flex: 1 1 auto; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ui-select-trigger::after {
      content: ""; flex: 0 0 auto; width: 10px; height: 6px;
      background: var(--ra-chevron) center / 10px 6px no-repeat;
      transition: transform .2s var(--ra-ease);
    }
    .ui-select-trigger[aria-expanded="true"]::after { transform: rotate(180deg); }

    .ui-select-panel {
      position: fixed; z-index: ${Z};
      max-height: 240px; overflow-y: auto;
      padding: 5px; border-radius: 12px;
      background: var(--ra-surface);
      border: 1px solid var(--ra-border);
      box-shadow: 0 10px 30px rgba(0, 0, 0, .18);
      font: 12.5px/1.5 var(--ra-font);
      color: var(--ra-fg);
      pointer-events: auto;
    }
    .ui-select-panel[hidden] { display: none; }
    .ui-select-item {
      padding: 7px 10px; border-radius: 7px; cursor: pointer;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .ui-select-item:hover { background: var(--ra-fill); }
    .ui-select-item.is-selected {
      color: var(--ra-accent); font-weight: 600; background: var(--ra-accent-soft);
    }
    .hm-theme:hover { color: var(--ra-fg); }
    .hm-theme:focus-visible { outline: 2px solid var(--ra-accent); outline-offset: 2px; }
    .hm-close {
      border: 0; background: transparent; cursor: pointer;
      font-size: 19px; line-height: 1; color: var(--ra-fg-subtle);
      padding: 2px 7px; border-radius: 7px;
      transition: background .2s var(--ra-ease), color .2s var(--ra-ease);
    }
    .hm-close:hover { background: var(--ra-fill); color: var(--ra-fg); }

    .hm-card {
      margin: 0 13px 11px; padding: 12px 13px;
      background: var(--ra-card);
      border: 1px solid var(--ra-glass-rim);
      border-radius: 14px;
    }
    .hm-name { font-size: 16px; font-weight: 600; line-height: 22px; letter-spacing: -.02em; }
    .hm-name.empty { font-size: 13.5px; font-weight: 500; color: var(--ra-fg-muted); }
    .hm-meta {
      margin-top: 2px; font-size: 12px; line-height: 18px;
      color: var(--ra-fg-muted); word-break: break-all;
    }
    .hm-meta:empty { display: none; }
    .hm-pills { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 9px; }
    .hm-pills:empty { display: none; }
    .hm-pill {
      padding: 1px 8px; border-radius: 999px;
      background: var(--ra-fill); color: var(--ra-fg-muted);
      font-size: 11px; line-height: 17px;
    }

    .hm-actions { display: flex; flex-direction: column; gap: 8px; padding: 0 13px; }
    .hm-row { display: flex; gap: 8px; }
    .hm-btn {
      width: 100%; padding: 9px 14px;
      border: 1px solid var(--ra-glass-rim); border-radius: 999px;
      background: var(--ra-glass);
      color: var(--ra-fg); font: inherit; font-size: 12.5px; font-weight: 500;
      cursor: pointer; white-space: nowrap;
      transition: transform .18s var(--ra-ease), background-color .18s var(--ra-ease);
    }
    .hm-btn:hover:not(:disabled) { background-color: var(--ra-fill); }
    .hm-btn:active:not(:disabled) { transform: scale(.97); }
    .hm-btn:focus-visible { outline: 2px solid var(--ra-accent); outline-offset: 2px; }
    .hm-btn:disabled { opacity: .45; cursor: default; }
    .hm-primary {
      border-color: transparent;
      background: var(--ra-accent);
      color: #fff; font-size: 13px; font-weight: 600;
      box-shadow: 0 1px 3px rgba(0, 113, 227, .24);
    }
    .hm-primary:hover:not(:disabled) {
      background: var(--ra-accent-hover);
      color: #fff;
      box-shadow: 0 3px 14px rgba(0, 113, 227, .3);
    }

    .hm-hint {
      padding: 10px 15px 0;
      font-size: 11px; line-height: 16px; color: var(--ra-fg-subtle);
    }
    .hm-foot {
      display: flex; justify-content: flex-end;
      margin-top: 10px; padding: 9px 15px 11px;
      border-top: 1px solid var(--ra-border);
    }
    .hm-link {
      border: 0; background: transparent; padding: 0;
      color: var(--ra-accent); font: inherit; font-size: 12px;
      cursor: pointer;
    }
    .hm-link:hover { text-decoration: underline; }

    @media (prefers-reduced-motion: reduce) {
      .wrap, .datapanel, .toast, .fab, .home { animation: none; }
      .dp-row, .dp-c, button.act, .dp-foot button, .fab, .hm-btn { transition: none; }
    }

  `;

  function ensureHost() {
    if (shadowRoot) return shadowRoot;
    let host = document.getElementById(HOST_ID);
    if (host && host.shadowRoot) {
      host.setAttribute('data-ra-theme', currentTheme);
      shadowRoot = host.shadowRoot;
      return shadowRoot;
    }
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-ra-ignore', '');
    host.setAttribute('data-ra-theme', currentTheme);
    (document.body || document.documentElement).appendChild(host);
    // 用 open 而不是 closed —— 这一层挡不住页面脚本（同源的话它们本来也够得着），
    // 但 open 让用户在 devtools 里能直接检查浮层结构，排查问题方便得多
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    shadowRoot = shadow;
    return shadowRoot;
  }

  function teardown() {
    clearMarks();
    clearHighlight();
    const host = document.getElementById(HOST_ID);
    if (host) host.remove();
    shadowRoot = null;
    fabEl = null;
    homeEl = null;
    // 悬浮入口不能跟着浮层一起消失，否则撤销一次就再也回不来了
    if (fabHandler) showFab(fabHandler);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  /**
   * 应用主题。注意这里改的是**浮层宿主元素**的属性，
   * 不是宿主网页的 <html>——绝不能改动别人页面的样式。
   * @param {'auto'|'light'|'dark'} setting
   */
  function applyTheme(setting) {
    let theme = 'light';
    try {
      theme = RA.storage.resolveTheme(setting);
    } catch (e) {
      // storage 还没加载好之类的，先按浅色来
    }
    currentTheme = theme;
    const host = document.getElementById(HOST_ID);
    if (host) host.setAttribute('data-ra-theme', theme);
    return theme;
  }

  // ─────────────────────── 字段高亮 ───────────────────────

  const OUTLINE_COLORS = {
    high: '#1a7f37',
    low: '#d4a72c',
    fail: '#cf222e',
    unfilled: '#8250df',
  };

  function markField(node, tier) {
    if (!node || !node.style) return;
    const color = OUTLINE_COLORS[tier] || OUTLINE_COLORS.high;
    const prevOutline = node.style.outline;
    const prevOffset = node.style.outlineOffset;
    node.style.outline = `${tier === 'unfilled' ? '2px dashed' : '2px solid'} ${color}`;
    node.style.outlineOffset = '1px';
    MARKS.push({ el: node, prevOutline, prevOffset });
  }

  /** 自动匹配没认出来的控件，用紫色虚线标出来，引导用户手动指定 */
  function markUnfilled(nodes) {
    for (const n of nodes || []) markField(n, 'unfilled');
  }

  function clearMarks() {
    while (MARKS.length) {
      const { el: node, prevOutline, prevOffset } = MARKS.pop();
      try {
        node.style.outline = prevOutline;
        node.style.outlineOffset = prevOffset;
      } catch (e) { /* 元素可能已被移除 */ }
    }
  }

  // ─────────────────────── 标注用的高亮框 ───────────────────────

  function setHighlight(rect, label) {
    const shadow = ensureHost();
    if (!highlightBox) {
      highlightBox = el('div', 'highlight');
      shadow.appendChild(highlightBox);
    }
    if (!rect) {
      highlightBox.style.display = 'none';
      return;
    }
    highlightBox.style.display = 'block';
    highlightBox.style.left = rect.left + 'px';
    highlightBox.style.top = rect.top + 'px';
    highlightBox.style.width = rect.width + 'px';
    highlightBox.style.height = rect.height + 'px';
    highlightBox.title = label || '';
  }

  function clearHighlight() {
    if (highlightBox) highlightBox.style.display = 'none';
  }

  function showHintBar(html) {
    const shadow = ensureHost();
    let bar = shadow.querySelector('.hintbar');
    if (bar) bar.remove();
    if (!html) return;
    bar = el('div', 'hintbar');
    // 这段文案是我们自己写的静态字符串，不来自页面
    bar.innerHTML = html;
    shadow.appendChild(bar);
  }

  function showToast(text, ms = 2200) {
    const shadow = ensureHost();
    const old = shadow.querySelector('.toast');
    if (old) old.remove();
    const t = el('div', 'toast', text);
    shadow.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // ─────────────────────── 页面内的悬浮入口 ───────────────────────

  let fabEl = null;
  /** 记住回调，浮层被 teardown 之后还能把按钮重新挂回来 */
  let fabHandler = null;
  /** 拖过之后的位置。teardown 会重建按钮，重建时要摆回原处 */
  let fabPos = null;

  /**
   * 左下角的悬浮按钮：点一下直接开数据面板，不用先点扩展图标。
   *
   * 只在顶层文档创建 —— content script 在每个 iframe 里都会跑，
   * 不做判断的话嵌套页面里会冒出一堆按钮。
   */
  function showFab(handler) {
    if (handler) fabHandler = handler;
    const shadow = ensureHost();
    if (fabEl && fabEl.isConnected) return fabEl;

    fabEl = el('button', 'fab');
    fabEl.type = 'button';
    fabEl.title = '简历数据面板';
    fabEl.setAttribute('aria-label', '打开简历数据面板');
    fabEl.setAttribute('data-ra-ignore', '');

    let src = '';
    try {
      src = root.chrome.runtime.getURL('icons/icon48.png');
    } catch (e) { /* 拿不到就退化成文字 */ }

    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.draggable = false;
      fabEl.appendChild(img);
    } else {
      fabEl.appendChild(el('span', 'txt', '简'));
    }

    // 拖过之后的位置要沿用，否则关一次结果面板按钮就跳回默认位置
    if (fabPos) {
      const left = clampNum(fabPos.left, 8, Math.max(8, window.innerWidth - 52 - 8));
      const top = clampNum(fabPos.top, 8, Math.max(8, window.innerHeight - 52 - 8));
      fabEl.style.left = left + 'px';
      fabEl.style.top = top + 'px';
      fabEl.style.right = 'auto';
      fabEl.style.bottom = 'auto';
    }

    fabEl.addEventListener('click', () => {
      // 刚拖完的那一次不算点击
      if (fabEl.__raDragged) { fabEl.__raDragged = false; return; }
      if (fabHandler) fabHandler();
    });

    shadow.appendChild(fabEl);
    makeFabDraggable(fabEl);
    return fabEl;
  }

  /**
   * 悬浮按钮自己既是点击目标又是拖动把手，用位移阈值分开：
   * 按下后移动超过 4px 才算拖，否则仍当作点击。
   */
  function makeFabDraggable(handle) {
    let active = false;
    let moved = false;
    let downX = 0, downY = 0, startLeft = 0, startTop = 0;
    // 首页卡片开着时，拖按钮要带着它一起走，这里记下它的起始位置和尺寸
    let cardEl = null;
    let cardLeft = 0, cardTop = 0, cardW = 0, cardH = 0;

    handle.__raDragged = false;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const r = handle.getBoundingClientRect();
      // 立刻换成 left/top 定位，拖的时候才不会按原锚点重算
      handle.style.left = r.left + 'px';
      handle.style.top = r.top + 'px';
      handle.style.right = 'auto';
      handle.style.bottom = 'auto';
      handle.style.animation = 'none';

      cardEl = (homeEl && homeEl.isConnected) ? homeEl : null;
      if (cardEl) {
        const cr = cardEl.getBoundingClientRect();
        cardLeft = cr.left;
        cardTop = cr.top;
        cardW = cr.width;
        cardH = cr.height;
        // 卡片原来是靠 left/bottom 定位的，先换成 left/top 才好一起平移
        cardEl.style.left = cardLeft + 'px';
        cardEl.style.top = cardTop + 'px';
        cardEl.style.right = 'auto';
        cardEl.style.bottom = 'auto';
        cardEl.style.animation = 'none';
      }

      downX = e.clientX; downY = e.clientY;
      startLeft = r.left; startTop = r.top;
      active = true;
      moved = false;
      handle.__raDragged = false;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    });

    handle.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      handle.__raDragged = true;

      const r = handle.getBoundingClientRect();
      const fabMaxL = Math.max(8, window.innerWidth - r.width - 8);
      const fabMaxT = Math.max(8, window.innerHeight - r.height - 8);

      let adx;
      let ady;

      if (cardEl) {
        // 卡片和按钮必须作为整体一起留在屏幕里。
        // 把两者的边界都换算成同一个位移区间，取交集再夹 ——
        // 否则卡片先撞边停住、按钮还在走，就会叠到卡片上。
        const cardMaxL = Math.max(8, window.innerWidth - cardW - 8);
        const cardMaxT = Math.max(8, window.innerHeight - cardH - 8);
        const loX = Math.max(8 - startLeft, 8 - cardLeft);
        const hiX = Math.min(fabMaxL - startLeft, cardMaxL - cardLeft);
        const loY = Math.max(8 - startTop, 8 - cardTop);
        const hiY = Math.min(fabMaxT - startTop, cardMaxT - cardTop);
        adx = Math.min(Math.max(dx, loX), hiX);
        ady = Math.min(Math.max(dy, loY), hiY);
        cardEl.style.left = (cardLeft + adx) + 'px';
        cardEl.style.top = (cardTop + ady) + 'px';
      } else {
        adx = clampNum(dx, 8 - startLeft, fabMaxL - startLeft);
        ady = clampNum(dy, 8 - startTop, fabMaxT - startTop);
      }

      const left = startLeft + adx;
      const top = startTop + ady;
      handle.style.left = left + 'px';
      handle.style.top = top + 'px';
      fabPos = { left, top };
    });

    const stop = (e) => {
      if (!active) return;
      active = false;
      cardEl = null;
      try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  /**
   * 结果面板和数据面板都会盖住右下角，那时候把按钮藏起来——
   * 否则它会从半透明的玻璃底下透出来，很难看。
   */
  function setFabVisible(visible) {
    if (!fabEl) return;
    const wrapOpen = !!(shadowRoot && shadowRoot.querySelector('.wrap'));
    fabEl.hidden = !visible || wrapOpen;
  }

  // ─────────────────────── 拖动 ───────────────────────

  function clampNum(v, lo, hi) {
    return Math.min(Math.max(v, lo), hi);
  }

  /**
   * 让浮层能用标题栏拖着走。
   *
   * 只能从标题栏拖：内容区要留给滚动和点击，抢走了面板就没法用了。
   * 按下的瞬间把 right/bottom 换算成 left/top 固定住 —— 否则一拖，
   * 面板会按原来的锚点重新定位，看起来就是「跳」一下。
   */
  function makeDraggable(panel, handle, fixHeight) {
    let dragging = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest('button')) return;

      const r = panel.getBoundingClientRect();
      panel.style.left = r.left + 'px';
      panel.style.top = r.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      // 数据面板是靠 top/bottom 撑高的，转成 left/top 之后必须补一个高度
      if (fixHeight) panel.style.height = r.height + 'px';
      // 入场动画带着 transform，拖之前先停掉，不然位置算不准
      panel.style.animation = 'none';

      startX = e.clientX;
      startY = e.clientY;
      startLeft = r.left;
      startTop = r.top;
      dragging = true;
      try { handle.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
      e.preventDefault();
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const r = panel.getBoundingClientRect();
      const maxL = Math.max(8, window.innerWidth - r.width - 8);
      const maxT = Math.max(8, window.innerHeight - r.height - 8);
      panel.style.left = clampNum(startLeft + (e.clientX - startX), 8, maxL) + 'px';
      panel.style.top = clampNum(startTop + (e.clientY - startY), 8, maxT) + 'px';
    });

    const stop = (e) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    };
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  // ─────────────────────── 悬浮首页卡片 ───────────────────────

  let homeEl = null;

  function closeHome() {
    if (homeEl) {
      homeEl.remove();
      homeEl = null;
    }
  }

  /**
   * 点悬浮按钮弹出来的首页卡片。内容对齐扩展弹窗：
   * 简历摘要 + 简历数据面板 / 自动填充 / 预览 + 编辑入口。
   *
   * 具体动作由调用方传进来 —— 浮层这层不该知道填充和面板怎么跑。
   */
  async function openHome(actions) {
    if (homeEl) return homeEl;

    const shadow = ensureHost();
    const card = el('div', 'home');
    card.setAttribute('data-ra-ignore', '');
    homeEl = card;

    const head = el('div', 'hm-head');
    try {
      const ico = document.createElement('img');
      ico.src = root.chrome.runtime.getURL('icons/icon48.png');
      ico.alt = '';
      ico.draggable = false;
      head.appendChild(ico);
    } catch (e) { /* 拿不到图标就只留标题 */ }
    head.appendChild(el('span', 'hm-title', '简历自动填写'));

    // 主题切换：和弹窗右上角那个是同一份设置，改哪边都会同步
    const themeSel = document.createElement('select');
    themeSel.className = 'hm-theme';
    themeSel.title = '切换主题';
    for (const [v, label] of [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      themeSel.appendChild(o);
    }
    themeSel.addEventListener('change', async () => {
      const theme = themeSel.value;
      RA.overlay.applyTheme(theme);
      try {
        const s = await RA.storage.getSettings();
        await RA.storage.setSettings({ ...s, theme });
      } catch (e) { /* 存不上不影响当前显示 */ }
    });
    head.appendChild(themeSel);
    try { RA.ui.select.enhance(themeSel, { panelRoot: shadow }); } catch (e) { /* 忽略 */ }

    const closeBtn = el('button', 'hm-close', '×');
    closeBtn.title = '关闭';
    closeBtn.addEventListener('click', closeHome);
    head.appendChild(closeBtn);
    card.appendChild(head);

    // 当前简历：投不同岗位时在卡片里直接切，不用回设置页
    const resumeRow = el('div', 'hm-resume');
    resumeRow.appendChild(el('span', 'hm-resume-label', '简历'));
    const resumeSel = document.createElement('select');
    resumeSel.className = 'hm-resume-select';
    resumeSel.title = '切换当前简历';
    resumeRow.appendChild(resumeSel);
    try { RA.ui.select.enhance(resumeSel, { panelRoot: shadow }); } catch (e) { /* 忽略 */ }
    card.appendChild(resumeRow);

    const summary = el('div', 'hm-card');
    const nameEl = el('div', 'hm-name');
    const metaEl = el('div', 'hm-meta');
    const pillsEl = el('div', 'hm-pills');
    summary.appendChild(nameEl);
    summary.appendChild(metaEl);
    summary.appendChild(pillsEl);
    card.appendChild(summary);

    const acts = el('div', 'hm-actions');
    const panelBtn = el('button', 'hm-btn hm-primary', '简历数据面板');
    acts.appendChild(panelBtn);

    const row = el('div', 'hm-row');
    const fillBtn = el('button', 'hm-btn', '自动填充');
    const prevBtn = el('button', 'hm-btn', '仅预览匹配');
    row.appendChild(fillBtn);
    row.appendChild(prevBtn);
    acts.appendChild(row);
    card.appendChild(acts);

    card.appendChild(el('div', 'hm-hint',
      '扩展只填内容，不会自动提交 —— 填完请自己核对再点提交。'));

    const foot = el('div', 'hm-foot');
    const linkBtn = el('button', 'hm-link', '编辑简历数据');
    foot.appendChild(linkBtn);
    card.appendChild(foot);

    // 故意不挂 makeDraggable：这张卡片只能跟着悬浮按钮一起移动，
    // 不能自己拖走 —— 否则它会和按钮脱钩，位置关系就乱了。

    const run = (fn) => () => {
      closeHome();
      try {
        Promise.resolve(fn()).catch(() => {});
      } catch (e) { /* 动作失败不该留下半开的卡片 */ }
    };
    panelBtn.addEventListener('click', run(actions.onPanel));
    fillBtn.addEventListener('click', run(actions.onFill));
    prevBtn.addEventListener('click', run(actions.onPreview));
    linkBtn.addEventListener('click', run(actions.onOptions));

    // 位置要等内容渲染完再算（卡片高度取决于简历里有几条经历），
    // 先隐藏着量尺寸，免得用户看到它先出现在默认位置再跳一下
    card.style.visibility = 'hidden';
    shadow.appendChild(card);

    /** 把一份简历的数据画到摘要卡上 */
    const applyProfile = (profile) => {
      nameEl.textContent = '';
      nameEl.classList.remove('empty');
      metaEl.textContent = '';
      pillsEl.textContent = '';

      if (!profile) {
        nameEl.textContent = '还没有填写简历数据';
        nameEl.classList.add('empty');
        metaEl.textContent = '点下方「编辑简历数据」开始';
        panelBtn.disabled = true;
        fillBtn.disabled = true;
        prevBtn.disabled = true;
        return;
      }

      panelBtn.disabled = false;
      fillBtn.disabled = false;
      prevBtn.disabled = false;

      const b = profile.basic || {};
      nameEl.textContent = b.name || '（未填写姓名）';
      if (!b.name) nameEl.classList.add('empty');
      metaEl.textContent = [b.phone, b.email].filter(Boolean).join(' · ');

      for (const [k, label] of [
        ['educations', '教育'], ['works', '工作'], ['internships', '实习'],
        ['projects', '项目'], ['certificates', '证书'], ['awards', '获奖'],
      ]) {
        const n = Array.isArray(profile[k]) ? profile[k].length : 0;
        if (n) pillsEl.appendChild(el('span', 'hm-pill', `${label} ${n}`));
      }
    };

    resumeSel.addEventListener('change', async () => {
      try {
        await RA.storage.setActiveResume(resumeSel.value);
        applyProfile(await RA.storage.getProfile());
      } catch (e) { /* 切换失败就保持原样 */ }
    });

    // 简历和设置一起取；取完才渲染内容、算位置、显示出来
    let profile = null;
    let settings = null;
    let resumes = null;
    try {
      const pair = await Promise.all([RA.storage.getProfile(), RA.storage.getSettings()]);
      profile = pair[0];
      settings = pair[1];
      resumes = await RA.storage.getResumes();
    } catch (e) { /* 按空处理 */ }
    if (homeEl !== card || !card.isConnected) return null;
    if (settings) themeSel.value = settings.theme || 'auto';

    if (resumes) {
      for (const r of resumes.list) {
        const o = document.createElement('option');
        o.value = r.id;
        o.textContent = r.name;
        resumeSel.appendChild(o);
      }
      resumeSel.value = resumes.activeId;
    }

    applyProfile(profile);

    placeCard(card);
    card.style.visibility = '';
    return card;
  }

  /**
   * 决定首页卡片开在哪。
   *
   * 首选按钮的左上角（卡片右下角对着按钮左上角，留 12px 缝）；
   * 左边放不下就翻到右边，上边放不下就翻到下边。四个象限自然就覆盖了：
   * 按钮在右下 → 左上；左下 → 右上；右上 → 左下；左上 → 右下。
   * 最后再夹一次边界，保证卡片永远完整地落在屏幕里。
   */
  function placeCard(card) {
    if (!fabEl || !fabEl.isConnected) return;

    const fr = fabEl.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const gap = 12;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = fr.left - cr.width - gap;
    if (left < 8) left = fr.right + gap;

    let top = fr.top - cr.height - gap;
    if (top < 8) top = fr.bottom + gap;

    left = clampNum(left, 8, Math.max(8, vw - cr.width - 8));
    top = clampNum(top, 8, Math.max(8, vh - cr.height - 8));

    card.style.left = left + 'px';
    card.style.top = top + 'px';
    card.style.right = 'auto';
    card.style.bottom = 'auto';
  }

  /** 悬浮按钮点一下：开着就关，关着就开 */
  async function toggleHome(actions) {
    if (homeEl) { closeHome(); return false; }
    await openHome(actions);
    return true;
  }

  // ─────────────────────── 结果面板 ───────────────────────

  function showPanel(rows, stats, title) {
    const shadow = ensureHost();
    const old = shadow.querySelector('.wrap');
    if (old) old.remove();

    const wrap = el('div', 'wrap');

    const header = el('header');
    header.appendChild(el('span', null, title || '简历填写结果'));
    const close = el('button', 'close', '×');
    close.title = '关闭面板（不会撤销已填内容）';
    close.addEventListener('click', () => teardown());
    header.appendChild(close);
    wrap.appendChild(header);

    const s = el('div', 'stats');
    const addStat = (cls, label, n) => {
      const d = el('span', cls);
      d.appendChild(el('b', null, n));
      d.appendChild(document.createTextNode(' ' + label));
      s.appendChild(d);
    };
    addStat('hi', '已填', stats.high);
    addStat('lo', '待确认', stats.low);
    if (stats.fail) addStat('bad', '失败', stats.fail);
    if (stats.unfilled) addStat('sk', '未识别', stats.unfilled);
    wrap.appendChild(s);

    const list = el('ul', 'rows');
    for (const r of rows) {
      const li = el('li', r.tier === 'high' ? '' : r.tier);
      li.appendChild(el('span', 'k', r.label));
      li.appendChild(el('span', 'v', r.value));
      if (r.note) li.appendChild(el('span', 'tag', r.note));
      list.appendChild(li);
    }
    wrap.appendChild(list);

    if (!rows.length) {
      wrap.appendChild(el('div', 'note', '没有识别到可填字段。可以打开数据面板一个个手动填。'));
    }

    const footer = el('footer');
    // 自动填充剩下的缺口，转去数据面板手点——比让用户教引擎认区块更直接
    const panelBtn = el('button', 'act', '打开数据面板');
    panelBtn.title = '剩下的空框可以用数据面板一个个点';
    panelBtn.addEventListener('click', () => RA.datapanel.open());

    // 遇到填不上的字段时，一键把现场信息复制出来发给开发者排查。
    // 里面包含扫描信号、匹配分数、失败原因和失败控件的 DOM（已隐藏个人隐私）。
    let diagBtn = null;
    if (RA.diag && typeof RA.diag.copy === 'function') {
      diagBtn = el('button', 'act', '复制诊断');
      diagBtn.title = '复制这次识别与填充的现场信息（不含手机号、身份证等隐私）';
      diagBtn.addEventListener('click', async () => {
        diagBtn.disabled = true;
        let r;
        try {
          r = await RA.diag.copy();
        } catch (e) {
          r = { ok: false, kb: 0 };
        }
        diagBtn.disabled = false;
        if (r && r.ok) {
          diagBtn.textContent = '已复制';
          showToast(`诊断信息已复制（约 ${r.kb} KB），直接粘贴给开发者即可`);
        } else {
          diagBtn.textContent = '复制失败';
          showToast('复制失败：请先点一下页面空白处，再试一次');
        }
        setTimeout(() => { diagBtn.textContent = '复制诊断'; }, 1800);
      });
    }

    const undo = el('button', 'act danger', '全部撤销');
    undo.addEventListener('click', () => {
      const n = RA.fill.undoAll();
      undo.textContent = `已撤销 ${n} 处`;
      undo.disabled = true;
      setTimeout(teardown, 700);
    });
    // 核对完了按这个收工，比点右上角的 × 更明确
    const done = el('button', 'act done', '完成');
    done.title = '确认填完了，关闭这个面板';
    done.addEventListener('click', () => teardown());

    footer.appendChild(panelBtn);
    if (diagBtn) footer.appendChild(diagBtn);
    footer.appendChild(undo);
    footer.appendChild(done);
    wrap.appendChild(footer);

    wrap.appendChild(el('div', 'note',
      '紫色虚线的框是自动匹配没认出来的。扩展不会自动提交，请核对后再点提交。'));

    shadow.appendChild(wrap);
    closeHome();
    setFabVisible(false);
  }

  RA.overlay = {
    showPanel,
    showFab,
    setFabVisible,
    openHome,
    closeHome,
    toggleHome,
    makeDraggable,
    teardown,
    markField,
    markUnfilled,
    clearMarks,
    setHighlight,
    clearHighlight,
    showHintBar,
    showToast,
    applyTheme,
    ensureHost,
    HOST_ID,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
