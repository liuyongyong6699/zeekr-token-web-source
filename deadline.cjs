'use strict';
// Application watchdog: do not wait for Playwright's possibly hung cleanup.
// Late results are ignored and rejection handlers always remain attached.
function withDeadline(task, ms, makeError, onTimeout) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); handler(value);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      let error;
      try { error = typeof makeError === 'function' ? makeError() : makeError; }
      catch (e) { error = e; }
      finish(reject, error || new Error('Operation timed out'));
      try { onTimeout?.(); } catch (_) { /* Expiration must still release callers. */ }
    }, ms);
    Promise.resolve().then(() => typeof task === 'function' ? task() : task)
      .then(value => finish(resolve, value), error => finish(reject, error));
  });
}
function boundedClose(task, ms = 1500) {
  return withDeadline(task, ms, () => new Error('Close deadline exceeded')).catch(() => {});
}
module.exports = { withDeadline, boundedClose };
