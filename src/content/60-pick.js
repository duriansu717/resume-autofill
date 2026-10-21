/**
 * 输入框选取模式。
 *
 * 数据面板要用它：用户点一下页面上的输入框，这个框就成为「待填目标」，
 * 然后点面板里的数据就能填进去。
 *
 * 单独抽成一个模块，是因为事件拦截很微妙：必须把页面的点击彻底吃掉，
 * 否则用户点一个下拉框想「选中它」，结果把那个下拉真的点开了。
 * 同时又要放行扩展自己浮层上的点击，否则面板按钮点不动——这两者的边界必须处理准。
 */
(function (root) {
  'use strict';

  const RA = root.RA;

  const CONTROL_SEL = 'input:not([type=hidden]):not([type=submit]):not([type=button]),select,textarea';

  let active = false;
  let lastTarget = null;
  let onTarget = null;

  // ─────────────────────── 目标解析 ───────────────────────

  function isOurs(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.id === RA.overlay.HOST_ID) return true;
    return !!(node.closest && node.closest('[data-ra-ignore]'));
  }

  /**
   * 这个事件是不是来自扩展自己的浮层？
   *
   * 必须判断，否则会出大问题：拦截器挂在 document 的捕获阶段，
   * 而数据面板也在 document 下面——不放行的话，点面板按钮时事件先被自己捕获，
   * stopPropagation 一执行就传不到按钮上，整个面板点哪儿都没反应。
   *
   * 不能用 e.target 判断：跨 shadow 边界时 e.target 会被重定向成宿主元素，
   * 拿不到里面真正的按钮。composedPath() 才能给出完整的事件路径。
   */
  function isFromOverlay(e) {
    const path = (typeof e.composedPath === 'function') ? e.composedPath() : [e.target];
    for (const n of path) {
      if (!n || n.nodeType !== 1) continue;
      if (n.id === RA.overlay.HOST_ID) return true;
      if (n.hasAttribute && n.hasAttribute('data-ra-ignore')) return true;
    }
    return false;
  }

  /**
   * 鼠标下面那个元素 → 真正要选中的输入框。
   * 点到标签或包裹层时也要能猜出对应的控件，否则用户很难精确点中框本身。
   */
  function resolveTarget(node) {
    if (!node || node.nodeType !== 1) return null;
    if (isOurs(node)) return null;

    if (/^(INPUT|SELECT|TEXTAREA)$/.test(node.tagName)) {
      return node.tagName === 'INPUT' && ['hidden', 'submit', 'button'].includes(node.type)
        ? null
        : node;
    }

    // <label for="xxx">
    if (node.tagName === 'LABEL' && node.htmlFor) {
      const byFor = document.getElementById(node.htmlFor);
      if (byFor) return byFor;
    }

    // 点到包裹层：往上三层里找，哪个容器恰好只含一个控件就是它
    let cur = node;
    for (let i = 0; i < 3 && cur; i++) {
      if (cur.querySelectorAll) {
        const inner = cur.querySelectorAll(CONTROL_SEL);
        if (inner.length === 1) return inner[0];
      }
      cur = cur.parentElement;
    }
    return null;
  }

  // ─────────────────────── 事件处理 ───────────────────────

  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onMove(e) {
    if (!active) return;

    // 这个处理函数同时挂在 mousemove 和 scroll 上。scroll 事件没有坐标，
    // 直接往 elementFromPoint 里塞 undefined 会变成 NaN 并抛
    // 「The provided double value is non-finite」。
    // 滚动时只需要让高亮跟着目标走。
    if (!Number.isFinite(e.clientX) || !Number.isFinite(e.clientY)) {
      if (lastTarget && lastTarget.isConnected) {
        try {
          RA.overlay.setHighlight(lastTarget.getBoundingClientRect());
        } catch (err) {
          RA.overlay.clearHighlight();
        }
      } else {
        RA.overlay.clearHighlight();
      }
      return;
    }

    const node = document.elementFromPoint(e.clientX, e.clientY);
    const target = resolveTarget(node);
    if (target === lastTarget) return;

    lastTarget = target;
    if (target) {
      try {
        RA.overlay.setHighlight(target.getBoundingClientRect());
      } catch (err) {
        RA.overlay.clearHighlight();
      }
    } else {
      RA.overlay.clearHighlight();
    }
  }

  function onMouseDown(e) {
    if (!active) return;
    if (isFromOverlay(e)) return; // 自己的面板要能点
    swallow(e);
  }

  function onClick(e) {
    if (!active) return;
    if (isFromOverlay(e)) return; // 自己的面板要能点
    swallow(e);

    // 合成事件可能没有坐标，别把 NaN 交给 elementFromPoint
    const node = (Number.isFinite(e.clientX) && Number.isFinite(e.clientY))
      ? document.elementFromPoint(e.clientX, e.clientY)
      : null;
    const target = resolveTarget(node);
    if (!target) {
      RA.overlay.showToast('这附近没有可填的输入框');
      return;
    }

    lastTarget = target;
    try {
      RA.overlay.setHighlight(target.getBoundingClientRect());
    } catch (err) { /* 忽略 */ }

    if (onTarget) onTarget(target);
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') {
      swallow(e);
      stop();
      RA.overlay.showToast('已退出选取模式');
    }
  }

  /** 这些事件也必须挡，否则页面上的下拉/日历会在选取时被点开 */
  const SWALLOWED = ['mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'];

  function onSwallow(e) {
    if (!active) return;
    if (isFromOverlay(e)) return;
    swallow(e);
  }

  function bind() {
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('mousedown', onMouseDown, true);
    for (const t of SWALLOWED) document.addEventListener(t, onSwallow, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onMove, true);
  }

  function unbind() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('mousedown', onMouseDown, true);
    for (const t of SWALLOWED) document.removeEventListener(t, onSwallow, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onMove, true);
  }

  // ─────────────────────── 生命周期 ───────────────────────

  /**
   * 开始选取。选完一个框不退出，可以接着选下一个——
   * 每选一个就退出会让人点到烦。
   * @param {(el: Element) => void} callback
   */
  function start(callback) {
    if (active) stop();
    active = true;
    lastTarget = null;
    onTarget = callback || null;

    RA.overlay.showHintBar(
      '点一下要填的输入框，然后在右侧面板点对应的数据　·　<kbd>Esc</kbd> 退出'
    );
    bind();
  }

  function stop() {
    if (!active) return;
    active = false;
    lastTarget = null;
    onTarget = null;
    unbind();
    RA.overlay.clearHighlight();
    RA.overlay.showHintBar(null);
  }

  RA.pick = {
    start,
    stop,
    isActive: () => active,
    resolveTarget,
    isFromOverlay,
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
