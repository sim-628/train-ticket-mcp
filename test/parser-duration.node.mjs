import assert from "node:assert/strict";
import test from "node:test";
import { parseTrainMarkdown } from "../src/parser.ts";

// Synthetic Markdown fixtures: no real-time inventory or price assertions.
function card(duration, {
  train = "G1932", departure = "13:38", arrival = "14:01",
  from = "上海虹桥", to = "苏州北", price = "38"
} = {}) {
  return [departure, from, duration,
    "![](https://s.qunarzz.com/train_rn_assets/images/list_direct_arrow_new.png)",
    `[${train}](https://huoche.qunar.com/train/timetable/${train})`,
    arrival, to, `**¥${price}**`,
    "二等座 **有票**一等座 **7张**无座 **抢票**"
  ].join("\n\n");
}
function page(cards, declared = cards.length) {
  return `当前筛选结果： **${declared}** 趟车次\n\n${cards.join("\n\n")}\n\n## 上海到苏州的中转方案\n`;
}

for (const [duration, arrival, expectedDate] of [
  ["1分", "13:39", "2026-11-12"],
  ["10分", "13:48", "2026-11-12"],
  ["23分", "14:01", "2026-11-12"],
  ["47分", "14:25", "2026-11-12"],
  ["59分", "14:37", "2026-11-12"],
  ["1时", "14:38", "2026-11-12"],
  ["1时2分", "14:40", "2026-11-12"],
  ["1天2时3分", "15:41", "2026-11-13"]
]) {
  test(`accepts duration ${duration} without dropping the train`, () => {
    const result = parseTrainMarkdown(page([card(duration, { arrival })]), "2026-11-12");
    assert.equal(result.expected_count, 1);
    assert.equal(result.parsed_count, 1);
    assert.equal(result.is_complete, true);
    assert.equal(result.trains[0].duration, duration);
    assert.equal(result.trains[0].arrival_date, expectedDate);
    assert.equal(result.trains[0].price, 38);
    assert.equal(result.trains[0].seat_options[1].remaining_count, 7);
  });
}

for (const duration of ["", "0分", "0时0分", "未定", "1时abc", "9007199254740992分"]) {
  test(`rejects invalid duration ${JSON.stringify(duration)} rather than declaring success`, () => {
    const result = parseTrainMarkdown(page([card(duration)]), "2026-11-12");
    assert.equal(result.parsed_count, 0);
    assert.equal(result.is_complete, false);
  });
}

test("minute-only duration calculates cross-year arrival correctly", () => {
  const result = parseTrainMarkdown(page([card("23分", {
    departure: "23:50", arrival: "00:13"
  })]), "2026-12-31");
  assert.equal(result.is_complete, true);
  assert.equal(result.trains[0].arrival_date, "2027-01-01");
});

test("306-row synthetic regression includes 259 minute-only and 47 hour-based rows", () => {
  const rows = Array.from({ length: 306 }, (_, index) => card(
    index < 259 ? "23分" : "1时2分",
    { train: `G${index + 1}`, arrival: index < 259 ? "14:01" : "14:40" }
  ));
  const result = parseTrainMarkdown(page(rows), "2026-11-12");
  assert.equal(result.expected_count, 306);
  assert.equal(result.parsed_count, 306);
  assert.equal(result.is_complete, true);
  assert.equal(result.trains.filter(t => t.duration === "23分").length, 259);
});

test("a genuinely incomplete page remains incomplete", () => {
  const result = parseTrainMarkdown(page([card("23分")], 306), "2026-11-12");
  assert.equal(result.parsed_count, 1);
  assert.equal(result.is_complete, false);
});

test("same train number with different listed stations remains separate", () => {
  const result = parseTrainMarkdown(page([
    card("23分"), card("10分", { from: "上海西", departure: "13:51" })
  ]), "2026-11-12");
  assert.equal(result.parsed_count, 2);
  assert.equal(result.is_complete, true);
});

test("minute-only rows after the transfer heading are excluded", () => {
  const result = parseTrainMarkdown(page([card("23分")]) + card("10分", { train: "G9999" }), "2026-11-12");
  assert.equal(result.parsed_count, 1);
  assert.equal(result.is_complete, true);
});
