/**
 * 后台只干一件事：替内容脚本打开选项页。
 *
 * 内容脚本能用的 chrome.* 只有很小一撮（runtime / storage / i18n 等），
 * 拿不到 chrome.runtime.openOptionsPage —— 必须由扩展上下文转一手。
 *
 * 没有别的常驻逻辑：不扫描、不注入、不联网。
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'RA_OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }
});
