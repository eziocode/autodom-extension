// Which Code Mode tools `tools/list` shows (AUTODOM_CODE_MODE).
//
//   unset / 1 / true / hybrid  hybrid: run_code, code_api and the script_*
//                              tools are listed next to every other tool
//                              (the default)
//   only                       just the Code Mode set (see CODE_ONLY_LISTED)
//   0 / off / false / no /     off: Code Mode is not listed; it stays
//   none / disabled            callable by name
//
// Any other value is the default (hybrid): a typo must not hide tools a
// client was relying on, and listing is the safer side of the two.
const OFF = new Set(["0", "off", "false", "no", "none", "disabled"]);

/** @returns {"hybrid" | "only" | "off"} */
export function codeModeListing(env = process.env) {
  const v = String(env.AUTODOM_CODE_MODE ?? "").trim().toLowerCase();
  if (v === "only") return "only";
  if (OFF.has(v)) return "off";
  return "hybrid";
}
