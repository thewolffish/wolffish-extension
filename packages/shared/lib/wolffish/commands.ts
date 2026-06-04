export const WolffishCommands = {
  // Navigation
  BROWSER_NAVIGATE: 'browser_navigate',
  BROWSER_BACK: 'browser_back',
  BROWSER_FORWARD: 'browser_forward',
  BROWSER_RELOAD: 'browser_reload',

  // Page Interaction
  BROWSER_CLICK: 'browser_click',
  BROWSER_TYPE: 'browser_type',
  BROWSER_SELECT: 'browser_select',
  BROWSER_HOVER: 'browser_hover',
  BROWSER_SCROLL: 'browser_scroll',
  BROWSER_FOCUS: 'browser_focus',
  BROWSER_KEYPRESS: 'browser_keypress',
  BROWSER_DRAG_DROP: 'browser_drag_drop',
  BROWSER_FILE_UPLOAD: 'browser_file_upload',

  // Page Reading
  BROWSER_READ_PAGE: 'browser_read_page',
  BROWSER_QUERY_SELECTOR: 'browser_query_selector',
  BROWSER_GET_ATTRIBUTE: 'browser_get_attribute',
  BROWSER_GET_VALUE: 'browser_get_value',
  BROWSER_GET_URL: 'browser_get_url',
  BROWSER_GET_PAGE_INFO: 'browser_get_page_info',

  // Tab Management
  BROWSER_TABS_LIST: 'browser_tabs_list',
  BROWSER_TAB_OPEN: 'browser_tab_open',
  BROWSER_TAB_CLOSE: 'browser_tab_close',
  BROWSER_TAB_SWITCH: 'browser_tab_switch',
  BROWSER_TAB_DUPLICATE: 'browser_tab_duplicate',
  BROWSER_TAB_MOVE: 'browser_tab_move',

  // Window Management
  BROWSER_WINDOWS_LIST: 'browser_windows_list',
  BROWSER_WINDOW_OPEN: 'browser_window_open',
  BROWSER_WINDOW_CLOSE: 'browser_window_close',
  BROWSER_WINDOW_RESIZE: 'browser_window_resize',

  // Screenshots & Visual
  BROWSER_SCREENSHOT: 'browser_screenshot',
  BROWSER_PDF: 'browser_pdf',

  // Cookies & Storage
  BROWSER_COOKIES_GET: 'browser_cookies_get',
  BROWSER_COOKIES_SET: 'browser_cookies_set',
  BROWSER_COOKIES_REMOVE: 'browser_cookies_remove',
  BROWSER_STORAGE_GET: 'browser_storage_get',
  BROWSER_STORAGE_SET: 'browser_storage_set',

  // Clipboard
  BROWSER_CLIPBOARD_READ: 'browser_clipboard_read',
  BROWSER_CLIPBOARD_WRITE: 'browser_clipboard_write',

  // Downloads
  BROWSER_DOWNLOAD: 'browser_download',

  // JavaScript Execution
  BROWSER_EXECUTE_JS: 'browser_execute_js',

  // Wait & Polling
  BROWSER_WAIT_FOR: 'browser_wait_for',
  BROWSER_WAIT_FOR_NAVIGATION: 'browser_wait_for_navigation',
  BROWSER_WAIT_FOR_NETWORK_IDLE: 'browser_wait_for_network_idle',

  // Notifications
  BROWSER_NOTIFY: 'browser_notify',
} as const;

export type WolffishCommandType = (typeof WolffishCommands)[keyof typeof WolffishCommands];

export const CONTENT_SCRIPT_COMMANDS: Set<string> = new Set([
  WolffishCommands.BROWSER_CLICK,
  WolffishCommands.BROWSER_TYPE,
  WolffishCommands.BROWSER_SELECT,
  WolffishCommands.BROWSER_HOVER,
  WolffishCommands.BROWSER_SCROLL,
  WolffishCommands.BROWSER_FOCUS,
  WolffishCommands.BROWSER_KEYPRESS,
  WolffishCommands.BROWSER_DRAG_DROP,
  WolffishCommands.BROWSER_FILE_UPLOAD,
  WolffishCommands.BROWSER_READ_PAGE,
  WolffishCommands.BROWSER_QUERY_SELECTOR,
  WolffishCommands.BROWSER_GET_ATTRIBUTE,
  WolffishCommands.BROWSER_GET_VALUE,
  WolffishCommands.BROWSER_GET_PAGE_INFO,
  WolffishCommands.BROWSER_STORAGE_GET,
  WolffishCommands.BROWSER_STORAGE_SET,
  WolffishCommands.BROWSER_CLIPBOARD_READ,
  WolffishCommands.BROWSER_CLIPBOARD_WRITE,
  WolffishCommands.BROWSER_WAIT_FOR,
  WolffishCommands.BROWSER_WAIT_FOR_NETWORK_IDLE,
]);

export const SERVICE_WORKER_COMMANDS: Set<string> = new Set([
  WolffishCommands.BROWSER_NAVIGATE,
  WolffishCommands.BROWSER_BACK,
  WolffishCommands.BROWSER_FORWARD,
  WolffishCommands.BROWSER_RELOAD,
  WolffishCommands.BROWSER_TABS_LIST,
  WolffishCommands.BROWSER_TAB_OPEN,
  WolffishCommands.BROWSER_TAB_CLOSE,
  WolffishCommands.BROWSER_TAB_SWITCH,
  WolffishCommands.BROWSER_TAB_DUPLICATE,
  WolffishCommands.BROWSER_TAB_MOVE,
  WolffishCommands.BROWSER_WINDOWS_LIST,
  WolffishCommands.BROWSER_WINDOW_OPEN,
  WolffishCommands.BROWSER_WINDOW_CLOSE,
  WolffishCommands.BROWSER_WINDOW_RESIZE,
  WolffishCommands.BROWSER_SCREENSHOT,
  WolffishCommands.BROWSER_PDF,
  WolffishCommands.BROWSER_COOKIES_GET,
  WolffishCommands.BROWSER_COOKIES_SET,
  WolffishCommands.BROWSER_COOKIES_REMOVE,
  WolffishCommands.BROWSER_DOWNLOAD,
  WolffishCommands.BROWSER_EXECUTE_JS,
  WolffishCommands.BROWSER_WAIT_FOR_NAVIGATION,
  WolffishCommands.BROWSER_NOTIFY,
  WolffishCommands.BROWSER_GET_URL,
]);
