// Hand-written result types and areas for the Code Mode API.
//
// Result types describe what a script receives on success (a failed call
// throws instead), after Code Mode's own normalisation: JSON parsed, image
// bytes swapped for an imageRef, an appended snapshot split into `snapshot`.
// They mirror the extension handlers in extension/background/service-worker.js
// (toolGetDomState, toolListTabs, ...); keep them in step when those change.
// Objects stay open (`[k: string]: any`) where a handler adds fields by mode.

const SNAPSHOT_FIELD = "/** Present when called with snapshot: \"diff\" | \"full\" */ snapshot?: string";

export const RESULT_TYPES = {
  get_dom_state: `{
    title: string; url: string;
    scope?: { strategy: string; label: string };
    elementCount: number;
    /** Use index with click_by_index / type_by_index. */
    elements: Array<{ index: number; tag: string; text?: string; type?: string; name?: string; placeholder?: string;
      href?: string; role?: string; ariaLabel?: string; value?: string; [k: string]: any }>;
    autoScrolled?: boolean; diagnostics?: Record<string, any>;
  }`,
  get_page_info: `{ title: string; url: string; lang?: string; readyState?: string; forms?: number; links?: number;
    images?: number; tabId: number; windowId: number; [k: string]: any }`,
  navigate: `{ success: true; url?: string; title?: string; action?: "back" | "forward" | "reload"; status?: string;
    ${SNAPSHOT_FIELD}; [k: string]: any }`,
  click: `{ success: true; tag?: string; text?: string; ${SNAPSHOT_FIELD}; [k: string]: any }`,
  type_text: `{ success: true; value?: string; ${SNAPSHOT_FIELD}; [k: string]: any }`,
  click_by_index: `{ success: true; index: number; tag: string; text: string; cached: boolean }`,
  type_by_index: `{ success: true; index: number; tag: string; value: string; cached: boolean }`,
  take_screenshot: `{ /** Pass to emitImage() to attach the image to the run_code result. */ imageRef: string;
    images: Array<{ imageRef: string; mimeType: string }>; /** Size and scale note */ text?: string }`,
  list_tabs: `{
    tabs: Array<{ id: number; listIndex: number; index: number; title: string; url: string; active: boolean;
      status: string; windowId: number; groupId?: number; autodomOwned?: boolean; autodomAdopted?: boolean }>;
    count: number; isolated?: boolean; scope?: "all" | "autodom-group";
  }`,
  open_new_tab: `{ success: true; tabId: number; url: string; title?: string; status?: string; windowId: number; [k: string]: any }`,
  switch_tab: `{ success: true; tabId: number; title?: string; url?: string; windowId?: number; [k: string]: any }`,
  query_elements: `{ count: number; items: Array<{ tag: string; text?: string; id?: string; className?: string;
    href?: string; src?: string; value?: string; visible: boolean }> }`,
  extract_text: `{ text: string }`,
  extract_data: `{ success: true; count: number; totalMatches: number; data: Array<Record<string, any>> }`,
  wait_for_element: `{ success: true; elapsed: number; state: string }`,
  wait_for_text: `{ success: true; found: true; elapsed: number }`,
  wait_for_navigation: `{ success: true; url: string; title: string; elapsed: number }`,
  get_cookies: `{ cookies: Array<{ name: string; value: string; domain: string; path: string; secure: boolean;
    httpOnly: boolean; expirationDate?: number; [k: string]: any }>; [k: string]: any }`,
  execute_code: `{ success: true; /** The script's JSON-serialized return value */ result: any }`,
  media_list: `{
    count: number; /** id of the largest visible video, or null */ primary: string | null;
    media: Array<{ id: string; index: number; tag: "video" | "audio"; src: string | null; srcType: "file" | "mse" | "stream" | "none";
      duration: number | null; live: boolean; currentTime: number; paused: boolean; readyState: number; width?: number; height?: number;
      visible: boolean; inViewport: boolean; drm: boolean; seekable: [number, number] | null; textTracks: number;
      frameId?: number; primary?: true; [k: string]: any }>;
    embeds?: Array<{ provider: string; src: string; visible: boolean; note: string }>;
  }`,
  media_get_captions: `{ ok: true; id: string; source: "track" | "youtube-transcript" | "dom-visible" | "none";
    tracks: Array<{ index: number; kind: string; label: string; language: string; mode: string }>; track: number;
    cues: Array<{ start: number; end: number | null; text: string }>; active: string[]; truncated?: true }`,
  media_sample_frames: `{ ok: true; video: { id: string; duration: number | null; width: number; height: number };
    /** images[i] is frames[i]; pass imageRef to emitImage() */ images: Array<{ imageRef: string; mimeType: string }>; imageRef: string;
    frames: Array<{ t: number; requestedT?: number; width: number; height: number; bytes: number; hash?: string; dark?: true }>;
    bytes?: number; dropped?: { blank: number; duplicate: number }; truncated?: string; source?: "viewport"; [k: string]: any }`,
  media_capture_frame: `{ ok: true; video: { id: string; duration: number | null; width: number; height: number };
    images: Array<{ imageRef: string; mimeType: string }>; imageRef: string;
    frames: Array<{ t: number; width: number; height: number; bytes: number }>; source?: "viewport"; [k: string]: any }`,
  image_get_data: `{ ok: true; src: string; naturalWidth: number; naturalHeight: number; width: number; height: number;
    images: Array<{ imageRef: string; mimeType: string }>; imageRef: string }`,
};

// Areas group the code_api index. Every bound tool should have one; the
// e2e test fails on any tool left in "other".
export const AREAS = [
  ["observe", ["take_snapshot", "get_dom_state", "query_elements", "deep_query", "extract_text", "extract_data", "get_html",
    "get_page_info", "take_screenshot", "get_bounding_box", "get_computed_style", "check_element_state", "verify_artifact_counts"]],
  ["act", ["click", "type_text", "fill_form", "select_option", "hover", "press_key", "scroll", "drag_and_drop", "double_click",
    "right_click", "middle_click", "force_click", "click_at_coordinates", "key_down", "key_up", "click_by_index",
    "type_by_index", "upload_file", "set_attribute"]],
  ["navigate", ["navigate", "wait_for_text", "wait_for_element", "wait_for_navigation", "wait_for_network_idle", "handle_dialog"]],
  ["tabs", ["list_tabs", "open_new_tab", "switch_tab", "close_tab", "pin_tab", "unpin_tab", "get_pinned_tab", "finish_session",
    "wait_for_new_tab", "list_popups", "switch_to_popup", "close_popup", "wait_for_popup", "list_iframes", "iframe_interact",
    "list_shadow_roots", "shadow_interact", "list_downloads", "wait_for_download"]],
  ["media", ["media_list", "media_control", "media_get_captions", "media_capture_frame", "media_sample_frames", "image_list",
    "image_get_data"]],
  ["script", ["execute_code", "browser_fetch_raw", "webmcp_list_tools", "webmcp_call_tool"]],
  ["debug", ["get_console_logs", "get_network_requests", "har_start", "har_status", "har_stop", "performance_start_trace",
    "performance_stop_trace", "performance_analyze_insight", "emulate", "emulate_media", "set_viewport", "set_geolocation",
    "print_to_pdf"]],
  ["storage", ["get_cookies", "set_cookie", "delete_cookie", "clear_cookies", "get_storage", "set_storage"]],
  ["workflow", ["workflow_record_start", "workflow_record_stop", "workflow_save", "workflow_list", "workflow_get", "workflow_run",
    "workflow_run_many", "workflow_export", "workflow_delete", "workflow_from_recording", "run_list", "run_get", "run_cancel",
    "run_undo", "schedule_create", "schedule_list", "schedule_update", "schedule_delete", "start_recording", "stop_recording",
    "get_recording"]],
  ["audit", ["audit_query", "autodom_diagnostics", "get_session_summary"]],
];

const AREA_OF = new Map(AREAS.flatMap(([area, names]) => names.map((n) => [n, area])));

export function areaOf(name) {
  return AREA_OF.get(name) || "other";
}

export const AREA_NAMES = [...AREAS.map(([a]) => a), "other"];
