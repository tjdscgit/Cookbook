// cookbook-timer.test.js — run with: node cookbook-timer.test.js
//
// Same no-framework style as cookbook-units.test.js. Covers the cook-mode timer parser.
const T = require("./cookbook-timer.js");

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.log(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`); }
}
function section(name) { console.log(`\n${name}`); }

section("timerFor");
eq(T.timerFor("Add onion and garlic and cook for 1 1/2 minutes until starting to go golden."),
  { s: 90, label: "1½ min" }, '"1 1/2 minutes" -> 90 s');
eq(T.timerFor("Add the sauce and cook for 2 to 3 minutes until well caramelised."),
  { s: 180, label: "3 min" }, '"2 to 3 minutes" uses the upper bound');
eq(T.timerFor("Leave for 45 seconds then turn."), { s: 45, label: "45 sec" }, '"45 seconds"');
eq(T.timerFor("Toss for 1 minute, until the sauce reduces."), { s: 60, label: "1 min" }, '"1 minute"');
eq(T.timerFor("Simmer gently for 2 hours."), { s: 7200, label: "120 min" }, '"2 hours"');
eq(T.timerFor("Serve straight away, garnished with green onion and sesame seeds."), null, "no time in the step -> no timer");
eq(T.timerFor("Heat the oven to 180 degrees."), null, "a number without a time unit -> no timer");
eq(T.timerFor(""), null, "empty step -> no timer");
eq(T.timerFor("Leave for 45 seconds then turn. Leave for 30 seconds."), { s: 45, label: "45 sec" }, "first time in the step wins");

section("clock");
eq(T.clock(161), "2:41", "161 s -> 2:41");
eq(T.clock(5), "0:05", "pads seconds");
eq(T.clock(7200), "120:00", "long timers count in minutes");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
