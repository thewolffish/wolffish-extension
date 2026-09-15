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
  BROWSER_SET_VALUE: 'browser_set_value',
  BROWSER_SUBMIT_FORM: 'browser_submit_form',

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
  // browser_wait is the generic entry models reach for first (it mirrors
  // the playwright capability's browser_wait): a plain sleep, or a
  // selector/navigation/network-idle wait dispatched on `type`. The
  // specific BROWSER_WAIT_FOR_* commands below remain the primary tools.
  BROWSER_WAIT: 'browser_wait',
  BROWSER_WAIT_FOR: 'browser_wait_for',
  BROWSER_WAIT_FOR_NAVIGATION: 'browser_wait_for_navigation',
  BROWSER_WAIT_FOR_NETWORK_IDLE: 'browser_wait_for_network_idle',

  // Notifications
  BROWSER_NOTIFY: 'browser_notify',

  // Wolffish tab group — the label the model puts on its own workspace
  BROWSER_SET_ACTIVITY: 'browser_set_activity',

  // Debugger Mode
  DEBUGGER_ATTACH: 'browser_debugger_attach',
  DEBUGGER_DETACH: 'browser_debugger_detach',
  DEBUGGER_STATUS: 'browser_debugger_status',

  // Mouse Interaction (coordinate- or selector-based; trusted input in debugger mode)
  BROWSER_MOUSE_MOVE: 'browser_mouse_move',
  BROWSER_MOUSE_CLICK: 'browser_mouse_click',
  BROWSER_MOUSE_DOWN: 'browser_mouse_down',
  BROWSER_MOUSE_UP: 'browser_mouse_up',
  BROWSER_MOUSE_DRAG: 'browser_mouse_drag',

  // Coordinate ↔ DOM bridging (read-only)
  BROWSER_ELEMENT_FROM_POINT: 'browser_element_from_point',
  BROWSER_GET_INTERACTIVE_ELEMENTS: 'browser_get_interactive_elements',

  // Humanize
  HUMANIZE: 'browser_humanize',

  // Snapshot + uid element references (v2)
  BROWSER_TAKE_SNAPSHOT: 'browser_take_snapshot',
  BROWSER_RESOLVE_UID: 'browser_resolve_uid',
  BROWSER_FIND: 'browser_find',
  BROWSER_FILL: 'browser_fill',
  BROWSER_FILL_FORM: 'browser_fill_form',

  // CDP-backed observation (v2)
  BROWSER_LIST_NETWORK_REQUESTS: 'browser_list_network_requests',
  BROWSER_GET_NETWORK_REQUEST: 'browser_get_network_request',
  BROWSER_LIST_CONSOLE_MESSAGES: 'browser_list_console_messages',
  BROWSER_HANDLE_DIALOG: 'browser_handle_dialog',
  BROWSER_EMULATE: 'browser_emulate',

  // Readiness probe (v2)
  BROWSER_DOCTOR: 'browser_doctor',
} as const;

export type WolffishCommandType = (typeof WolffishCommands)[keyof typeof WolffishCommands];

/**
 * Commands implemented in the page. `browser_file_upload` also appears in the
 * service-worker set, which wins: that handler picks the CDP path for real
 * file paths and delegates back here for base64 content.
 */
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
  WolffishCommands.BROWSER_SET_VALUE,
  WolffishCommands.BROWSER_SUBMIT_FORM,
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
  WolffishCommands.BROWSER_ELEMENT_FROM_POINT,
  WolffishCommands.BROWSER_GET_INTERACTIVE_ELEMENTS,
  // v2: snapshot/fill/find have a content-script (DOM) implementation that
  // is the fallback when the tab has no CDP session; the dispatcher swaps to
  // the CDP handler when one exists (see DEBUGGER_ROUTABLE_COMMANDS).
  WolffishCommands.BROWSER_TAKE_SNAPSHOT,
  WolffishCommands.BROWSER_RESOLVE_UID,
  WolffishCommands.BROWSER_FIND,
  WolffishCommands.BROWSER_FILL,
  WolffishCommands.BROWSER_FILL_FORM,
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
  // Service-worker side so a bare sleep works with no page attached; the
  // selector/network-idle variants delegate to the content script.
  WolffishCommands.BROWSER_WAIT,
  WolffishCommands.BROWSER_WAIT_FOR_NAVIGATION,
  WolffishCommands.BROWSER_NOTIFY,
  WolffishCommands.BROWSER_SET_ACTIVITY,
  WolffishCommands.BROWSER_GET_URL,
  WolffishCommands.BROWSER_FILE_UPLOAD,
  WolffishCommands.DEBUGGER_ATTACH,
  WolffishCommands.DEBUGGER_DETACH,
  WolffishCommands.DEBUGGER_STATUS,
  WolffishCommands.BROWSER_MOUSE_MOVE,
  WolffishCommands.BROWSER_MOUSE_CLICK,
  WolffishCommands.BROWSER_MOUSE_DOWN,
  WolffishCommands.BROWSER_MOUSE_UP,
  WolffishCommands.BROWSER_MOUSE_DRAG,
  WolffishCommands.HUMANIZE,
  // v2: these need a CDP session and live in the service worker; without a
  // session they answer with a deterministic "needs the debugger" error.
  WolffishCommands.BROWSER_LIST_NETWORK_REQUESTS,
  WolffishCommands.BROWSER_GET_NETWORK_REQUEST,
  WolffishCommands.BROWSER_LIST_CONSOLE_MESSAGES,
  WolffishCommands.BROWSER_HANDLE_DIALOG,
  WolffishCommands.BROWSER_EMULATE,
  WolffishCommands.BROWSER_DOCTOR,
]);

/**
 * Content-script commands the dispatcher re-routes to a CDP handler when the
 * resolved tab has a debugger session. Each has a content-script twin with the
 * same contract, so a CDP failure falls through to the DOM implementation.
 */
export const DEBUGGER_ROUTABLE_COMMANDS: Set<string> = new Set([
  WolffishCommands.BROWSER_CLICK,
  WolffishCommands.BROWSER_TYPE,
  WolffishCommands.BROWSER_SCROLL,
  WolffishCommands.BROWSER_HOVER,
  WolffishCommands.BROWSER_KEYPRESS,
  WolffishCommands.BROWSER_TAKE_SNAPSHOT,
  WolffishCommands.BROWSER_RESOLVE_UID,
  WolffishCommands.BROWSER_FIND,
  WolffishCommands.BROWSER_FILL,
  WolffishCommands.BROWSER_FILL_FORM,
  WolffishCommands.BROWSER_FILE_UPLOAD,
  WolffishCommands.BROWSER_SET_VALUE,
  WolffishCommands.BROWSER_GET_VALUE,
  WolffishCommands.BROWSER_FOCUS,
  WolffishCommands.BROWSER_SELECT,
  WolffishCommands.BROWSER_GET_ATTRIBUTE,
]);

/**
 * Commands that change the page. After any of these the service worker runs
 * the post-action wait (navigation / DOM-quiet) and decorates the result with
 * `navigated` / `domChanged`; they also drive the on-page shadow cursor.
 */
export const INPUT_COMMANDS: Set<string> = new Set([
  WolffishCommands.BROWSER_CLICK,
  WolffishCommands.BROWSER_TYPE,
  WolffishCommands.BROWSER_SELECT,
  WolffishCommands.BROWSER_HOVER,
  WolffishCommands.BROWSER_SCROLL,
  WolffishCommands.BROWSER_FOCUS,
  WolffishCommands.BROWSER_KEYPRESS,
  WolffishCommands.BROWSER_DRAG_DROP,
  WolffishCommands.BROWSER_FILE_UPLOAD,
  WolffishCommands.BROWSER_SET_VALUE,
  WolffishCommands.BROWSER_SUBMIT_FORM,
  WolffishCommands.BROWSER_FILL,
  WolffishCommands.BROWSER_FILL_FORM,
  WolffishCommands.BROWSER_MOUSE_MOVE,
  WolffishCommands.BROWSER_MOUSE_CLICK,
  WolffishCommands.BROWSER_MOUSE_DOWN,
  WolffishCommands.BROWSER_MOUSE_UP,
  WolffishCommands.BROWSER_MOUSE_DRAG,
  WolffishCommands.BROWSER_NAVIGATE,
  WolffishCommands.BROWSER_BACK,
  WolffishCommands.BROWSER_FORWARD,
  WolffishCommands.BROWSER_RELOAD,
  WolffishCommands.BROWSER_EXECUTE_JS,
  WolffishCommands.HUMANIZE,
]);

/**
 * Commands that only observe the page. They light the "reading" pill on the
 * overlay but never move the shadow cursor.
 */
export const READ_COMMANDS: Set<string> = new Set([
  WolffishCommands.BROWSER_READ_PAGE,
  WolffishCommands.BROWSER_QUERY_SELECTOR,
  WolffishCommands.BROWSER_GET_ATTRIBUTE,
  WolffishCommands.BROWSER_GET_VALUE,
  WolffishCommands.BROWSER_GET_URL,
  WolffishCommands.BROWSER_GET_PAGE_INFO,
  WolffishCommands.BROWSER_SCREENSHOT,
  WolffishCommands.BROWSER_PDF,
  WolffishCommands.BROWSER_STORAGE_GET,
  WolffishCommands.BROWSER_WAIT,
  WolffishCommands.BROWSER_WAIT_FOR,
  WolffishCommands.BROWSER_WAIT_FOR_NAVIGATION,
  WolffishCommands.BROWSER_WAIT_FOR_NETWORK_IDLE,
  WolffishCommands.BROWSER_ELEMENT_FROM_POINT,
  WolffishCommands.BROWSER_GET_INTERACTIVE_ELEMENTS,
  WolffishCommands.BROWSER_TAKE_SNAPSHOT,
  WolffishCommands.BROWSER_RESOLVE_UID,
  WolffishCommands.BROWSER_FIND,
  WolffishCommands.BROWSER_LIST_NETWORK_REQUESTS,
  WolffishCommands.BROWSER_GET_NETWORK_REQUEST,
  WolffishCommands.BROWSER_LIST_CONSOLE_MESSAGES,
]);

/**
 * Commands that must not run while a JavaScript dialog is open on the tab —
 * the page is frozen behind it, so the only useful answer is "handle it".
 */
export const DIALOG_BLOCKED_COMMANDS: Set<string> = new Set([
  ...INPUT_COMMANDS,
  WolffishCommands.BROWSER_TAKE_SNAPSHOT,
  WolffishCommands.BROWSER_FIND,
  WolffishCommands.BROWSER_READ_PAGE,
  WolffishCommands.BROWSER_SCREENSHOT,
]);
