/**
 * 自定义下拉框。
 *
 * 原生 <select> 展开后的列表由操作系统绘制，CSS 管不到——Windows 上那是一块
 * 灰底白字的系统菜单，和整套界面完全不搭。这里用「隐藏原生控件 + 自绘列表」的方式
 * 换掉外观，同时保留原控件的 value / change 语义，调用方不用改任何代码。
 *
 * 用法：
 *   RA.ui.select.enhance(selectEl)                        // 普通页面
 *   RA.ui.select.enhance(selectEl, { panelRoot: shadow }) // Shadow DOM 里
 */
(function (root) {
  'use strict';

  const RA = root.RA;
  RA.ui = RA.ui || {};

  /** 一个 panelRoot 只放一个面板，反复重渲染也不会漏 DOM */
  const panels = new WeakMap();

  /** 当前打开的那个下拉，全局唯一 */
  let current = null;

  function panelFor(rootNode) {
    let p = panels.get(rootNode);
    if (!p) {
      const el = document.createElement('div');
      el.className = 'ui-select-panel';
      el.setAttribute('role', 'listbox');
      el.hidden = true;
      rootNode.appendChild(el);
      p = { el };
      panels.set(rootNode, p);
    }
    return p.el;
  }

  function closeCurrent() {
    if (current) current.close();
  }

  // 全局监听只注册一次。注意不能放在模块顶层——Node 里没有 document/window，
  // 一执行就炸，整个模块都挂不上。
  let globalsBound = false;

  function bindGlobals() {
    if (globalsBound) return;
    globalsBound = true;

    try {
      // 点别处 / Esc 关掉
      document.addEventListener('pointerdown', (e) => {
        if (!current) return;
        const path = typeof e.composedPath === 'function' ? e.composedPath() : [e.target];
        if (path.indexOf(current.panel) >= 0 || path.indexOf(current.trigger) >= 0) return;
        closeCurrent();
      }, true);

      document.addEventListener('keydown', (e) => {
        if (current && e.key === 'Escape') {
          e.stopPropagation();
          closeCurrent();
        }
      }, true);

      // 滚动 / 缩放时位置会错，直接关掉。刚打开的一瞬间可能有布局抖动，忽略掉
      const closeOnMove = () => {
        if (!current) return;
        if (Date.now() - current.at < 150) return;
        closeCurrent();
      };

      root.addEventListener('scroll', closeOnMove, true);
      root.addEventListener('resize', closeOnMove);
    } catch (e) { /* 环境不支持就算了 */ }
  }

  /**
   * 把原生 select 升级成自绘下拉。
   * @param {HTMLSelectElement} select 必须已经挂到 DOM 上
   * @param {{ panelRoot?: Node }} [opts]
   */
  function enhance(select, opts) {
    if (!select || select.__raSelect) return select && select.__raSelectApi;
    if (!select.parentNode) return null; // 还没进 DOM，先别动

    bindGlobals();
    select.__raSelect = true;

    const o = opts || {};
    const panel = panelFor(o.panelRoot || document.body);

    // 原生控件藏起来，但仍然是值和 change 事件的真实来源
    select.style.display = 'none';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    // 复制原控件的类名，排版（flex 宽度、内边距）和原来完全一致
    trigger.className = 'ui-select-trigger ' + (select.className || '');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const label = document.createElement('span');
    label.className = 'ui-select-label';
    trigger.appendChild(label);

    select.parentNode.insertBefore(trigger, select.nextSibling);

    let isOpen = false;

    const currentOption = () => select.options[select.selectedIndex] || null;

    function syncLabel() {
      const opt = currentOption();
      label.textContent = opt ? opt.textContent : '';
      trigger.classList.toggle('is-empty', !opt);
    }

    function buildItems() {
      panel.textContent = '';
      Array.prototype.forEach.call(select.options, (opt, i) => {
        const item = document.createElement('div');
        item.className = 'ui-select-item' + (i === select.selectedIndex ? ' is-selected' : '');
        item.setAttribute('role', 'option');
        item.textContent = opt.textContent;
        item.title = opt.textContent;
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          select.selectedIndex = i;
          syncLabel();
          close();
          // 关闭之后再派发：change 里通常会重渲染界面
          select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        panel.appendChild(item);
      });
    }

    function place() {
      const r = trigger.getBoundingClientRect();
      const width = Math.max(r.width, 120);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));

      panel.style.width = width + 'px';
      panel.style.left = left + 'px';
      panel.style.top = (r.bottom + 6) + 'px';

      // 下面放不下就翻到上面
      const h = panel.offsetHeight;
      if (r.bottom + 6 + h > window.innerHeight - 8) {
        panel.style.top = Math.max(8, r.top - 6 - h) + 'px';
      }
    }

    function open() {
      if (isOpen) return;
      closeCurrent();

      // 面板可能比卡片先创建（第一次 enhance 时），同 z-index 下 DOM 靠后的会盖住它。
      // 每次打开时挪到最后，保证永远在最上层。
      if (panel.parentNode) panel.parentNode.appendChild(panel);

      buildItems();
      panel.hidden = false;
      isOpen = true;
      trigger.setAttribute('aria-expanded', 'true');
      trigger.classList.add('is-open');

      place();

      const cur = panel.querySelector('.is-selected');
      if (cur) {
        panel.scrollTop = Math.max(0, cur.offsetTop - panel.clientHeight / 2 + cur.offsetHeight / 2);
      }

      current = { close, panel, trigger, at: Date.now() };
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.classList.remove('is-open');
      if (current && current.close === close) current = null;
    }

    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (isOpen) close();
      else open();
    });

    // 代码里经常 textContent='' 再重填选项，这里跟着同步
    const mo = new MutationObserver(() => {
      syncLabel();
      if (isOpen) buildItems();
    });
    mo.observe(select, { childList: true, subtree: true, characterData: true });

    // 代码里直接写 select.value 时也要同步显示
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    if (desc && desc.get && desc.set) {
      Object.defineProperty(select, 'value', {
        configurable: true,
        get() { return desc.get.call(select); },
        set(v) {
          desc.set.call(select, v);
          syncLabel();
        },
      });
    }

    syncLabel();

    const api = { sync: syncLabel, close, trigger, panel };
    select.__raSelectApi = api;
    return api;
  }

  RA.ui.select = { enhance };
})(typeof globalThis !== 'undefined' ? globalThis : window);
