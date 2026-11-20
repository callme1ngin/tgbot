module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,

  TEMPLATES: {
    ADD_ERROR: 'addFriendError',
    ERROR: 'BrowserError',
    FRIEND: 'friendpage.bundle',
    STEAM_CHINA: 'steamchina.bundle',
    // CS2 screens: canvas templates that take their data through window.renderProfile().
    CS2_WRONG_CODE: 'cs2_wrong_code',
    CS2_NOT_FOUND: 'cs2_not_found',
    CS2_BAN: 'cs2_ban',
    // Dota screens: SVG templates with one <text id="friend-id"> to fill.
    DOTA_NOT_FOUND: 'dota_not_found',
    DOTA_NOT_FRIENDS: 'dota_not_friends'
  },

  SELECTORS: {
    // Селекторы для парсинга данных со ссылки
    // Заполнить когда будут известны нужные элементы
    title: null,
    description: null,
    image: null,
  },

  // Плейсхолдеры в шаблонах (что заменяется на реальные данные)
  PLACEHOLDERS: {
    TITLE: '{{TITLE}}',
    DESCRIPTION: '{{DESCRIPTION}}',
    IMAGE_URL: '{{IMAGE_URL}}',
    PROFILE_NAME: '{{PROFILE_NAME}}',
    AVATAR_URL: '{{AVATAR_URL}}',
    AVATAR_FRAME_URL: '{{AVATAR_FRAME_URL}}',
    AVATAR_FRAME_DISPLAY: '{{AVATAR_FRAME_DISPLAY}}',
    FRIEND_COUNT: '{{FRIEND_COUNT}}',
    PROFILE_URL: '{{PROFILE_URL}}',
    STEAM_ID: '{{STEAM_ID}}',
    FRIEND_CODE: '{{FRIEND_CODE}}',
    FRIEND_CODE_INPUT: '{{FRIEND_CODE_INPUT}}',
    FRIEND_CODE_INPUT_PLACEHOLDER: '{{FRIEND_CODE_INPUT_PLACEHOLDER}}',
    BROWSER_TAB_TITLE: '{{BROWSER_TAB_TITLE}}',
    BROWSER_URL_PROTOCOL: '{{BROWSER_URL_PROTOCOL}}',
    BROWSER_URL_DISPLAY: '{{BROWSER_URL_DISPLAY}}',
    SENT_URL: '{{SENT_URL}}',
  }
};
