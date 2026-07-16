// The embed's unmute tap coalescing, extracted so it can be tested.
// touchend AND click both fire for one physical tap on most touch browsers, and
// preventDefault does not reliably suppress the follow-up click in every webview.
// A blind toggle therefore flips muted -> unmuted -> muted and the viewer hears
// nothing — identical, from their side, to a dead button. This is the rule that
// stops that. Keep it in sync with public/embed.html.
const test = require('node:test');
const assert = require('node:assert');

// Mirrors applySound() in embed.html: explicit state + a 500ms coalescing window.
function makeTapHandler(video, now = () => Date.now()) {
  let lastTap = 0;
  return function tap() {
    const t = now();
    if (t - lastTap < 500) return false; // same physical tap, already handled
    lastTap = t;
    video.muted = !video.muted;
    return true;
  };
}

test('one physical tap = one unmute, even when touchend AND click both fire', () => {
  const video = { muted: true };
  let clock = 1000;
  const tap = makeTapHandler(video, () => clock);

  assert.equal(tap(), true, 'touchend handled');
  clock += 20;                        // the ~300ms follow-up click, fired fast
  assert.equal(tap(), false, 'duplicate click ignored');

  assert.equal(video.muted, false, 'stays UNMUTED — a toggle would re-mute here');
});

test('a real second tap (after the window) mutes again', () => {
  const video = { muted: true };
  let clock = 1000;
  const tap = makeTapHandler(video, () => clock);

  tap();                              // unmute
  assert.equal(video.muted, false);

  clock += 600;                       // deliberate later tap
  assert.equal(tap(), true);
  assert.equal(video.muted, true, 'toggles back off — the button still works');
});

test('the follow-up click is ignored right at the window edge', () => {
  const video = { muted: true };
  let clock = 5000;
  const tap = makeTapHandler(video, () => clock);

  tap();
  clock += 499;                       // still within the coalescing window
  assert.equal(tap(), false);
  assert.equal(video.muted, false, 'one tap, one state change');
});
