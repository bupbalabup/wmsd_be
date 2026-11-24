// Delivery dates are calendar days in Vietnam time (UTC+7, no daylight saving).
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' });
export const vnDay = (value = new Date()) => formatter.format(new Date(value));
export const vnMidnight = day => new Date(`${day}T00:00:00+07:00`);
