module.exports = {
  BOT_TOKEN: process.env.BOT_TOKEN,

  TEMPLATES: {
    ADD_ERROR: 'addFriendError',
    // Ошибка браузера в двух вариантах: у каждого свой фон, своя вкладка и своя адресная строка.
    // Данные приходят через window.renderBrowserError({ url, nick }).
    ERROR_CHROME: 'browser_error_chrome',
    ERROR_EDGE: 'browser_error_edge',
    FRIEND: 'friendpage.bundle',
    // Phone mockup of the same screen: a fixed 875×1798 frame with window.renderSteamFriend().
    FRIEND_MOBILE: 'friendpage-mobile.bundle',
    // Friend page with a QR of the link; the QR is generated on the server.
    QR_FRIEND: 'steam_community_qr',
    // A ready-made overlay: the same link goes into the address bar and into the notice line.
    STEAM_NOTICE: 'steam_notice',
    // Phone version of the add-friend error screen.
    ADD_ERROR_PHONE: 'steam_friend_invite_phone',
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
    SENT_URL: '{{SENT_URL}}',
  }
};
