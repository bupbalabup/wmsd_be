// Pure schedule arithmetic for recurring stocktake plans (22 Nov 2026; calendar fixed to Asia/Ho_Chi_Minh the same day).
// Occurrence n is the start instant plus n * step calendar months on the Asia/Ho_Chi_Minh calendar (UTC+7, no DST),
// with the local day clamped to the target month's length, so a plan that starts on 31 Jan falls on 28/29 Feb and
// 31 Mar and never drifts. The local time of day is kept. Implementation: shift the instant by +7 h, do the calendar
// arithmetic with UTC getters, shift back.
export const FREQUENCY_MONTHS = Object.freeze({ MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 });
const DAY_MS = 86_400_000;
export const LOCAL_UTC_OFFSET_MS = 7 * 3_600_000;

export function occurrence(startDate, frequency, periodNo) {
    const local = new Date(new Date(startDate).getTime() + LOCAL_UTC_OFFSET_MS), months = local.getUTCMonth() + FREQUENCY_MONTHS[frequency] * periodNo;
    const year = local.getUTCFullYear() + Math.floor(months / 12), month = ((months % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const shifted = Date.UTC(year, month, Math.min(local.getUTCDate(), lastDay), local.getUTCHours(), local.getUTCMinutes(), local.getUTCSeconds(), local.getUTCMilliseconds());
    return new Date(shifted - LOCAL_UTC_OFFSET_MS);
}

// The first period at or after `fromPeriodNo` whose due instant is later than `now` (missed periods are skipped).
export function firstPeriodAfter(startDate, frequency, fromPeriodNo, now) {
    let periodNo = fromPeriodNo;
    while (occurrence(startDate, frequency, periodNo) <= now)
        periodNo += 1;
    return periodNo;
}

// OVERDUE: due now or earlier. DUE_SOON: due within reminderDays. NOT_DUE otherwise; only ACTIVE plans are ever due.
export function dueState(header, workflowStatus, now = new Date()) {
    if (workflowStatus !== 'ACTIVE' || !header.nextDueAt)
        return 'NOT_DUE';
    const due = new Date(header.nextDueAt).getTime();
    if (due <= now.getTime())
        return 'OVERDUE';
    return due - now.getTime() <= (header.reminderDays ?? 0) * DAY_MS ? 'DUE_SOON' : 'NOT_DUE';
}

export const canGenerate = (header, workflowStatus, now = new Date()) => dueState(header, workflowStatus, now) !== 'NOT_DUE';
export const reminderWindowMs = reminderDays => reminderDays * DAY_MS;
