import type { Train, SeatOption } from "./types";

const TRAIN_LINK = /^\[([A-Z]\d{1,5})\]\(https:\/\/huoche\.qunar\.com\/train\/timetable\/[^)]+\)$/;
const RECOMMENDATION_TAGS = new Set(["最短耗时", "最低价格", "最多人买", "最优方案"]);

function cleanLine(value: string): string {
  return value.replace(/^\*\*(.*?)\*\*$/, "$1").trim();
}

function isTime(value: string): boolean {
  return /^\d{2}:\d{2}$/.test(value);
}

function durationToMinutes(duration: string): number | null {
  const match = duration.match(/^(?:(\d+)天)?(?:(\d+)时)?(?:(\d+)分)?$/);
  if (!match || !match[0]) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  return days * 1440 + hours * 60 + minutes;
}

function addDuration(date: string, departureTime: string, duration: string): string {
  const minutes = durationToMinutes(duration);
  if (minutes === null) return date;

  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = departureTime.split(":").map(Number);
  const start = Date.UTC(year, month - 1, day, hour, minute);
  const arrival = new Date(start + minutes * 60_000);

  return [
    arrival.getUTCFullYear(),
    String(arrival.getUTCMonth() + 1).padStart(2, "0"),
    String(arrival.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function parseSeats(text: string): SeatOption[] {
  const seats: SeatOption[] = [];
  const seatPattern = /([^*\n]+?)\s*\*\*(有票|无票|候补|抢票|售罄|\d+张)\*\*/g;

  for (const match of text.matchAll(seatPattern)) {
    const seatType = match[1].trim();
    const availability = match[2].trim();
    const count = availability.match(/^(\d+)张$/);
    if (!seatType) continue;

    seats.push({
      seat_type: seatType,
      availability,
      remaining_count: count ? Number(count[1]) : null
    });
  }

  return seats;
}

export interface ParsedTrainPage {
  expected_count: number | null;
  parsed_count: number;
  is_complete: boolean;
  trains: Train[];
}

export function parseTrainMarkdown(
  markdown: string,
  queryDate: string
): ParsedTrainPage {
  const start = markdown.indexOf("当前筛选结果");
  if (start < 0) {
    throw new Error("TRAIN_LIST_NOT_FOUND: missing current-filter section");
  }

  // The route is dynamic; do not hard-code a particular origin/destination here.
  const afterStart = markdown.slice(start);
  const transferHeading = afterStart.search(/^## .+的中转方案\s*$/m);
  const section = transferHeading >= 0
    ? afterStart.slice(0, transferHeading)
    : afterStart;

  const countMatch = section.match(/当前筛选结果：\s*\*\*(\d+)\*\*/);
  const expectedCount = countMatch ? Number(countMatch[1]) : null;
  const lines = section.split(/\r?\n/).map((line) => line.trim());
  const trains: Train[] = [];

  for (let i = 0; i < lines.length; i++) {
    const linkMatch = lines[i].match(TRAIN_LINK);
    if (!linkMatch) continue;

    const before: string[] = [];
    for (let j = i - 1; j >= 0 && before.length < 5; j--) {
      const line = lines[j];
      if (!line || line.startsWith("![")) continue;
      before.push(line);
    }

    const preceding = before.reverse();
    const coreBefore = preceding.slice(-3);
    if (coreBefore.length !== 3) continue;

    const departureTime = cleanLine(coreBefore[0]);
    const departureStation = cleanLine(coreBefore[1]);
    const duration = cleanLine(coreBefore[2]);
    if (!isTime(departureTime) || !/^\d+时\d+分$/.test(duration)) continue;

    const possibleTag = preceding.length >= 4
      ? cleanLine(preceding[preceding.length - 4])
      : "";
    const recommendationTag = RECOMMENDATION_TAGS.has(possibleTag) ? possibleTag : null;

    const after: string[] = [];
    for (let j = i + 1; j < lines.length && after.length < 4; j++) {
      if (lines[j]) after.push(lines[j]);
    }
    if (after.length < 4) continue;

    const arrivalTime = cleanLine(after[0]);
    const arrivalStation = cleanLine(after[1]);
    const fareMatch = after[2].match(/^\*\*¥([\d,.]+)\*\*$/);
    if (!isTime(arrivalTime) || !fareMatch) continue;

    const seatOptions = parseSeats(after[3]);
    if (seatOptions.length === 0) continue;

    trains.push({
      train_number: linkMatch[1],
      departure_station: departureStation,
      departure_time: departureTime,
      arrival_station: arrivalStation,
      arrival_time: arrivalTime,
      arrival_date: addDuration(queryDate, departureTime, duration),
      duration,
      price: Number(fareMatch[1].replace(/,/g, "")),
      recommendation_tag: recommendationTag,
      seat_options: seatOptions
    });
  }

  return {
    expected_count: expectedCount,
    parsed_count: trains.length,
    is_complete: expectedCount !== null && trains.length === expectedCount,
    trains
  };
}
