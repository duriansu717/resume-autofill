/**
 * Popup —— 只是个遥控器。
 *
 * popup 一旦失焦就会被销毁，所以所有需要持续存在的交互都在页面内完成，
 * 这里只负责发指令和汇总结果。
 *
 * 逐帧发送而不是广播：chrome.tabs.sendMessage 不带 frameId 时会发给所有帧，
 * 但只接受「第一个应答」，而哪个帧先应答是不确定的——
 * 如果先应答的是个没有表单的空 iframe，结果就丢了。
 */
(function () {
  'use strict';

  const RA = globalThis.RA;

  const $ = (id) => document.getElementById(id);

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  /**
   * 哪些帧可能装了内容脚本。
   *
   * 必须放行 file:// —— 本地测试页就是这种协议。
   * 注意 file:// 还要求用户在扩展详情页手动打开「允许访问文件网址」，
   * Chrome 不让扩展自己申请这个权限。
   */
  const SUPPORTED_URL = /^(https?|file):/i;

  async function listFrames(tabId) {
    try {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return (frames || []).filter((f) => SUPPORTED_URL.test(f.url || ''));
    } catch (e) {
      return [{ frameId: 0, url: '' }];
    }
  }

  /** 内容脚本到底有没有跑起来？ping 一下最准。 */
  async function pingTab(tabId) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'RA_PING' }, { frameId: 0 });
      return !!(r && r.ok);
    } catch (e) {
      return false;
    }
  }

  /** 逐帧发送，收集所有有字段的帧的应答 */
  async function askAllFrames(msg) {
    const tab = await activeTab();
    if (!tab || tab.id == null) return { results: [], tab };

    const frames = await listFrames(tab.id);
    const results = [];

    await Promise.all(frames.map(async (f) => {
      try {
        const r = await chrome.tabs.sendMessage(tab.id, msg, { frameId: f.frameId });
        if (r && (r.found || r.ok)) results.push({ ...r, frameId: f.frameId });
      } catch (e) {
        // 这一帧没有内容脚本，或者消息通道关了——正常情况，跳过
      }
    }));

    return { results, tab };
  }

  // ─────────────────────── 渲染 ───────────────────────

  function renderProfile(profile) {
    const box = $('profile-summary');
    box.textContent = '';

    if (!profile) {
      const name = document.createElement('div');
      name.className = 'p-name empty';
      name.textContent = '还没有填写简历数据';
      box.appendChild(name);

      const meta = document.createElement('div');
      meta.className = 'p-meta';
      meta.textContent = '点下方「编辑简历数据」开始';
      box.appendChild(meta);

      setBusy(true); // 没有数据，所有操作都没意义
      return;
    }

    const b = profile.basic || {};

    const name = document.createElement('div');
    name.className = 'p-name';
    name.textContent = b.name || '（未填写姓名）';
    box.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'p-meta';
    meta.textContent = [b.phone, b.email].filter(Boolean).join(' · ');
    box.appendChild(meta);

    const counts = document.createElement('div');
    counts.className = 'p-counts';
    for (const [k, label] of [
      ['educations', '教育'], ['works', '工作'], ['internships', '实习'],
      ['projects', '项目'], ['certificates', '证书'], ['awards', '获奖'],
    ]) {
      const n = Array.isArray(profile[k]) ? profile[k].length : 0;
      if (!n) continue;
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = `${label} ${n}`;
      counts.appendChild(pill);
    }
    box.appendChild(counts);
  }

  /** 当前简历下拉：在弹窗里就能切换，不用打开设置页 */
  async function renderResumes() {
    const state = await RA.storage.getResumes();
    const sel = $('resume-select');
    if (!sel) return;

    sel.textContent = '';
    for (const r of state.list) {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r.name;
      sel.appendChild(o);
    }
    sel.value = state.activeId;
  }

  function renderResult(summary, results) {
    const box = $('result');
    box.textContent = '';
    box.hidden = false;

    const total = {
      high: 0, low: 0, fail: 0, skip: 0, found: 0, added: 0,
      preview: [],
    };
    for (const r of results) {
      total.high += r.high || 0;
      total.low += r.low || 0;
      total.fail += r.fail || 0;
      total.skip += r.skip || 0;
      total.found += r.found || 0;
      total.added += r.added || 0;
      if (r.preview) total.preview.push(...r.preview);
    }

    const stats = document.createElement('div');
    stats.className = 'stats';
    const add = (label, n, cls) => {
      const s = document.createElement('span');
      if (cls) s.className = cls;
      const b = document.createElement('b');
      b.textContent = String(n);
      s.appendChild(b);
      s.appendChild(document.createTextNode(' ' + label));
      stats.appendChild(s);
    };
    add('已填', total.high, 'stat-hi');
    add('待确认', total.low, 'stat-lo');
    if (total.fail) add('失败', total.fail, 'stat-bad');
    if (total.skip) add('跳过', total.skip, 'stat-sk');
    box.appendChild(stats);

    if (summary) {
      const p = document.createElement('div');
      p.className = 'summary-line';
      p.textContent = summary;
      box.appendChild(p);
    }

    if (total.preview.length) {
      const ul = document.createElement('ul');
      for (const row of total.preview.slice(0, 20)) {
        const li = document.createElement('li');
        li.className = row.tier === 'high' ? '' : (row.tier || '');
        const k = document.createElement('span');
        k.className = 'k';
        k.textContent = row.label || '';
        const v = document.createElement('span');
        v.className = 'v';
        v.textContent = row.value == null ? '' : String(row.value);
        li.appendChild(k);
        li.appendChild(v);
        ul.appendChild(li);
      }
      box.appendChild(ul);
    }

    snapPopupHeight();
  }

  /**
   * 把弹窗内容高度补到「CSS 整数 × 设备像素整数」的点上。
   *
   * Chrome 按整数 CSS 像素给弹窗窗口定高，页面却按实际的小数高度绘制画布。
   * 125% 缩放下内容高度是 419.6px —— 窗口取整成 420（525 设备像素），
   * 画布只画到 524.5，最底下就空出 1 个设备像素，露出窗口底座的深色。
   * 这就是那条黑线，和字体、圆角都无关，是 Chrome 的舍入问题。
   *
   * 用 min-height 顶到那个点上（不是 padding —— padding 要先做小数加法，
   * 结果会差千分之几像素，又掉回舍入的坑里）。
   * step 取「几个 CSS 像素等于整数个设备像素」：100% → 1，125% → 4，
   * 150% → 2，175% → 4，200% → 1。
   */
  function snapPopupHeight() {
    const body = document.body;
    if (!body) return;

    // 清掉上一次补的高度，量到内容的真实高度
    body.style.minHeight = '';

    const dpr = window.devicePixelRatio || 1;
    let step = 1;
    for (let k = 1; k <= 8; k++) {
      if (Math.abs(k * dpr - Math.round(k * dpr)) < 1e-6) { step = k; break; }
    }

    const h = body.getBoundingClientRect().height;
    // 减一个极小量：h 正好落在边界上时不要再往上顶一格
    const target = Math.ceil(h / step - 1e-6) * step;
    if (target - h > 1e-9) body.style.minHeight = target + 'px';
  }

  function setHint(text) {
    $('hint').textContent = text || '';
    snapPopupHeight();
  }

  const ACTION_IDS = ['btn-fill', 'btn-scan', 'btn-panel'];

  /** 当前标签页是不是本地文件。决定通信失败时该给什么提示。 */
  let isFilePage = false;

  /**
   * 通信失败的原因有好几种，说清楚比笼统的「请刷新」有用得多。
   * 本地文件最常见的原因是没开「允许访问文件网址」——
   * 这种情况下刷新一百次也没用。
   */
  function commError() {
    return isFilePage
      ? '扩展没能在这个页面运行。本地文件需要先在 chrome://extensions 的扩展详情页'
        + '打开「允许访问文件网址」，然后刷新本页。'
      : '无法与页面通信，请刷新页面后重试。';
  }

  function setBusy(busy) {
    for (const id of ACTION_IDS) {
      const el = $(id);
      if (el) el.disabled = busy;
    }
  }

  // ─────────────────────── 动作 ───────────────────────

  async function doFill() {
    setBusy(true);
    setHint('正在填充…');
    $('result').hidden = true;
    try {
      const { results } = await askAllFrames({ type: 'RA_FILL' });
      if (!results.length) {
        renderResult('页面上没有找到可识别的表单字段。如果是单页应用，等表单渲染完再试一次。', []);
        setHint('');
        return;
      }
      const added = results.reduce((s, r) => s + (r.added || 0), 0);
      renderResult(added ? `自动新增了 ${added} 条经历输入框。` : '', results);
      setHint('已填充，请在页面上核对');
    } catch (e) {
      renderResult(commError(), []);
      setHint('通信失败');
    } finally {
      setBusy(false);
    }
  }

  async function doScan() {
    setBusy(true);
    setHint('正在分析…');
    $('result').hidden = true;
    try {
      const { results } = await askAllFrames({ type: 'RA_SCAN' });
      if (!results.length) {
        renderResult('没有识别到表单字段。', []);
        setHint('');
        return;
      }
      renderResult('以下是将要填入的对应关系（未实际写入）：', results);
      setHint('预览完成');
    } catch (e) {
      renderResult(commError(), []);
      setHint('通信失败');
    } finally {
      setBusy(false);
    }
  }

  /**
   * 开关页面右侧的简历数据面板。
   * 发完消息就关掉 popup —— 用户接下来要操作页面。
   */
  async function togglePanel() {
    setBusy(true);
    try {
      const { results } = await askAllFrames({ type: 'RA_DATAPANEL' });
      if (!results.length) {
        setBusy(false);
        setHint('这个页面上没有找到表单');
        return;
      }
      window.close();
    } catch (e) {
      setBusy(false);
      setHint(isFilePage ? '需要在扩展详情页打开「允许访问文件网址」' : '无法与页面通信，请刷新页面后重试');
    }
  }

  // ─────────────────────── 初始化 ───────────────────────

  (async function init() {
    $('version').textContent = 'v' + RA.version;

    // 先应用主题，避免深色系统的用户看到一闪而过的白底
    try {
      const settings = await RA.storage.getSettings();
      RA.storage.applyThemeToDocument(settings.theme);
      $('theme-select').value = settings.theme;
    } catch (e) { /* 读不到设置就按系统来 */ }

    const profile = await RA.storage.getProfile();
    renderProfile(profile);
    snapPopupHeight();
    await renderResumes();

    // 原生下拉换成自绘列表
    RA.ui.select.enhance($('theme-select'));
    RA.ui.select.enhance($('resume-select'));

    $('resume-select').addEventListener('change', async () => {
      await RA.storage.setActiveResume($('resume-select').value);
      const p = await RA.storage.getProfile();
      renderProfile(p);
      setBusy(!p);
      $('result').hidden = true;
      setHint('');
      snapPopupHeight();
    });

    $('btn-panel').addEventListener('click', togglePanel);
    $('btn-fill').addEventListener('click', doFill);
    $('btn-scan').addEventListener('click', doScan);

    $('link-options').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });

    // 主题切换：先立即生效，再落盘。存储失败也不影响当前显示。
    $('theme-select').addEventListener('change', async () => {
      const theme = $('theme-select').value;
      RA.storage.applyThemeToDocument(theme);
      try {
        // setSettings 是整体覆盖，要把现有设置合并进去
        const s = await RA.storage.getSettings();
        await RA.storage.setSettings({ ...s, theme });
      } catch (e) { /* 存不上就算了 */ }
    });

    const tab = await activeTab();
    const url = (tab && tab.url) || '';
    isFilePage = /^file:/i.test(url);

    if (url && !SUPPORTED_URL.test(url)) {
      setHint('此页面不支持填充');
      $('hint').title = '仅支持 http / https / 本地文件页面';
      setBusy(true);
      return;
    }

    // 本地文件要单独检查：没开「允许访问文件网址」时内容脚本压根跑不起来，
    // 点按钮只会得到一句「无法通信」，很难猜到真实原因
    if (/^file:/i.test(url)) {
      const ok = await pingTab(tab.id);
      if (!ok) {
        setHint('请先在 chrome://extensions 的扩展详情页打开「允许访问文件网址」，然后刷新本页');
      } else {
        setHint('本地文件模式');
      }
    }
  })();
})();
