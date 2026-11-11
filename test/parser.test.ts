import { describe, expect, it } from "vitest";
import { parseTrainMarkdown } from "../src/parser";

describe("parseTrainMarkdown", () => {
  it("parses a direct train and its seat inventory", () => {
    const markdown = `当前筛选结果： **1** 趟车次

最短耗时

18:57

杭州西

4时28分

![arrow](https://example.com/a.png)

[G50](https://huoche.qunar.com/train/timetable/G50)

23:25

北京南

**¥656**

二等座 **有票**一等座 **有票**商务座 **9张**无座 **抢票**

## 杭州东到北京南的中转方案
`;

    const result = parseTrainMarkdown(markdown, "2026-11-22");
    expect(result.parsed_count).toBe(1);
    expect(result.is_complete).toBe(true);
    expect(result.trains[0]).toMatchObject({
      train_number: "G50",
      departure_station: "杭州西",
      arrival_station: "北京南",
      price: 656,
      arrival_date: "2026-11-22",
      recommendation_tag: "最短耗时"
    });
    expect(result.trains[0].seat_options[2].remaining_count).toBe(9);
  });

  it("keeps same train numbers when they represent different listed departures", () => {
    const markdown = `当前筛选结果： **2** 趟车次

08:42

杭州东

6时11分

[G756](https://huoche.qunar.com/train/timetable/G756)

14:53

北京南

**¥638**

二等座 **有票**

08:57

杭州东

5时56分

[G756](https://huoche.qunar.com/train/timetable/G756)

14:53

北京南

**¥630**

二等座 **抢票**

## 杭州东到北京南的中转方案
`;
    const result = parseTrainMarkdown(markdown, "2026-11-22");
    expect(result.parsed_count).toBe(2);
    expect(result.trains.map((train) => train.price)).toEqual([638, 630]);
  });
});
