/**
 * The invariants of the tools/call fuzz stage. judgeCall() is pure: it reads one call's outcome and returns findings.
 *
 *   LIFE-1  the server process is still there after the call (no crash, also on an oversize argument)
 *   LIFE-2  the call is answered within the time limit (no hang)
 *   ERR-1   an error response has the JSON-RPC shape: an integer `code`, a string `message`, no `result` beside it, and the
 *           answer carries the request's id
 *   ERR-2   a call to a tool the server does not list is an error (-32602, or a tool result with isError true), never a success
 *   OUT-1   a successful result of a tool that declares an outputSchema has structuredContent that satisfies it
 *   ISERR-1 `isError`, when present, is a boolean, and `isError: true` carries a non-empty `content` array
 *   ISERR-2 arguments that violate the tool's inputSchema (a case that expects `reject`) are answered with an error
 *   RES-1   a successful result has a `content` array
 *
 * A check that needs something we cannot read (a schema keyword the reader does not know) is `inconclusive`, never a
 * finding. Findings carry short details, never the server's whole answer.
 */
import { validate } from './schema.mjs';

export const INVARIANTS = Object.freeze(['LIFE-1', 'LIFE-2', 'ERR-1', 'ERR-2', 'OUT-1', 'ISERR-1', 'ISERR-2', 'RES-1']);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const cap = (s) => String(s).slice(0, 160);

/**
 * @param {{tool: object|null, kase: {id: string, class: string, expect: string}, outcome: object, strays?: object[]}} c
 * @returns {{findings: {id: string, kind: string, case: string, detail: string}[], inconclusive: {id: string, why: string}[]}}
 */
export function judgeCall({ tool, kase, outcome, strays = [] }) {
  const findings = [];
  const inconclusive = [];
  const add = (id, kind, detail) => findings.push({ id, kind, case: kase.id, detail: cap(detail) });
  if (outcome.exited) { add('LIFE-1', 'server_exited', `the server process ended during the call (code ${outcome.exited.code ?? 'none'}, signal ${outcome.exited.signal ?? 'none'})`); return { findings, inconclusive }; }
  if (outcome.lineCap) { inconclusive.push({ id: 'LIFE-1', why: 'the answer was over our line cap' }); return { findings, inconclusive }; }
  if (outcome.timedOut) {
    if (strays.some((s) => s.id !== null && s.id !== undefined)) add('ERR-1', 'response_id_mismatch', 'the server answered with an id that was not the request\'s');
    else add('LIFE-2', 'no_answer', 'no answer within the time limit');
    return { findings, inconclusive };
  }
  const r = outcome.response;
  if (!isObj(r)) { add('ERR-1', 'not_an_object', 'the answer is not a JSON object'); return { findings, inconclusive }; }
  const hasErr = Object.hasOwn(r, 'error');
  const hasRes = Object.hasOwn(r, 'result');
  if (hasErr && hasRes) { add('ERR-1', 'result_and_error', 'the answer has both result and error'); return { findings, inconclusive }; }
  if (!hasErr && !hasRes) add('ERR-1', 'neither_result_nor_error', 'the answer has neither result nor error');
  if (hasErr && (!isObj(r.error) || !Number.isInteger(r.error.code) || typeof r.error.message !== 'string')) add('ERR-1', 'bad_error_shape', 'the error has no integer code and string message');
  const isRpcError = hasErr && !hasRes;
  const res = hasRes && isObj(r.result) ? r.result : null;
  if (hasRes && !res) { add('RES-1', 'result_not_object', 'the result is not an object'); return { findings, inconclusive }; }
  const isErrorField = res && Object.hasOwn(res, 'isError') ? res.isError : undefined;
  if (res && isErrorField !== undefined && typeof isErrorField !== 'boolean') add('ISERR-1', 'iserror_not_boolean', `isError is ${typeof isErrorField}`);
  // A malformed isError is ISERR-1 and nothing else: the call cannot be told apart as success or failure.
  if (res && isErrorField !== undefined && typeof isErrorField !== 'boolean') return { findings, inconclusive };
  const toolError = res && isErrorField === true;
  if (toolError && !(Array.isArray(res.content) && res.content.length > 0)) add('ISERR-1', 'iserror_empty_content', 'isError is true with no content');
  const failed = isRpcError || toolError;
  if (kase.class === 'unknown-tool' && !failed && res) add('ERR-2', 'unknown_tool_succeeded', 'a tool the server does not list answered with a success result');
  if (kase.expect === 'reject' && !failed && res) add('ISERR-2', 'invalid_input_succeeded', 'arguments that violate the inputSchema got a success result');
  if (res && !failed) {
    if (!Array.isArray(res.content)) add('RES-1', 'result_without_content', 'a success result has no content array');
    if (tool && isObj(tool.outputSchema)) {
      if (res.structuredContent === undefined) add('OUT-1', 'structured_content_missing', 'the tool declares an outputSchema and the result has no structuredContent');
      else {
        const v = validate(tool.outputSchema, res.structuredContent);
        if (v.unsupported) inconclusive.push({ id: 'OUT-1', why: `outputSchema not read: ${v.unsupported}` });
        else if (!v.ok) add('OUT-1', 'output_schema_mismatch', v.errors[0] ?? 'structuredContent does not satisfy the outputSchema');
      }
    }
  }
  return { findings, inconclusive };
}
