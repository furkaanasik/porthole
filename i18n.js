'use strict';

// Interface text. UI_LANG picks the language (en by default). The server fills index.html's
// {{key}} placeholders and hands the whole table to app.js as window.STRINGS.

const STRINGS = {
  en: {
    back: 'Back',
    forward: 'Forward',
    reload: 'Reload',
    home: 'Home',
    address: 'Search or type an address',
    hd: 'High quality',
    sound: 'Sound',
    video: 'Open video',
    keyboard: 'Keyboard',
    tapToType: 'Tap to type',
    go: 'Go',
    done: 'Done',
    close: 'Close',
    takenOver: 'Opened on another device. Tap to take it back.',
    unreachable: 'Cannot connect. Tap to reload.',
    reconnecting: 'Connection lost, reconnecting…',
    hdOn: 'HD on: full quality while scrolling too.',
    hdOff: 'HD off: smoothness first while scrolling.',
    streamFailed: 'Could not decode the video stream; switched to frames.',
    noSound: 'This browser cannot play sound.',
    soundOn: 'Sound on. On an iPad, the mute switch silences it.',
    noVideo: 'This browser cannot play the video.',
    videoPreparing: 'Preparing video…',
    live: 'live',
    videoNotFound: 'No playable video on this page.',
    videoBotCheck: 'YouTube asked for a bot check. Sign in to YouTube in Porthole and try again.',
    videoLogin: 'This video needs a login. Sign in to the site in Porthole and try again.',
    videoFailed: 'Could not open the video: ',
  },
  tr: {
    back: 'Geri',
    forward: 'İleri',
    reload: 'Yenile',
    home: 'Ana sayfa',
    address: 'Adres yaz ya da ara',
    hd: 'Yüksek kalite',
    sound: 'Ses',
    video: 'Videoyu aç',
    keyboard: 'Klavye',
    tapToType: 'Yazmak için dokun',
    go: 'Git',
    done: 'Bitti',
    close: 'Kapat',
    takenOver: 'Başka bir cihazda açıldı. Buraya dönmek için dokun.',
    unreachable: 'Bağlanılamıyor. Sayfayı yenilemek için dokun.',
    reconnecting: 'Bağlantı koptu, yeniden bağlanılıyor…',
    hdOn: 'HD açık: kaydırırken de tam kalite.',
    hdOff: 'HD kapalı: kaydırırken akıcılık öncelikli.',
    streamFailed: 'Video akışı çözülemedi, kare moduna geçildi.',
    noSound: 'Bu tarayıcı sesi çalamıyor.',
    soundOn: 'Ses açık. iPad sessiz modundaysa ses gelmez.',
    noVideo: 'Bu tarayıcı videoyu oynatamıyor.',
    videoPreparing: 'Video hazırlanıyor…',
    live: 'canlı',
    videoNotFound: 'Bu sayfada oynatılabilir bir video bulunamadı.',
    videoBotCheck: 'YouTube robot kontrolü istedi. Porthole içinde YouTube hesabına giriş yapıp tekrar dene.',
    videoLogin: 'Bu video giriş istiyor. Porthole içinde siteye giriş yapıp tekrar dene.',
    videoFailed: 'Video açılamadı: ',
  },
};

const LANG = STRINGS[process.env.UI_LANG] ? process.env.UI_LANG : 'en';
const T = STRINGS[LANG];

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// index.html with its placeholders filled and the string table inlined for app.js.
function localizeHtml(html) {
  return html
    .replace('<html lang="en">', `<html lang="${LANG}">`)
    .replace(/\{\{(\w+)\}\}/g, (all, key) => (T[key] ? escapeHtml(T[key]) : all))
    .replace('<script src="app.js"></script>', `<script>window.STRINGS = ${JSON.stringify(T).replace(/</g, '\\u003c')};</script>\n<script src="app.js"></script>`);
}

module.exports = { LANG, T, localizeHtml };
