//! Parsing of the 5-field cron expressions jobs are stored with.
//!
//! Jobs are written by people and by agents, and everything that tells them how
//! (the settings placeholder, the MCP tool description, the app-cron presets)
//! speaks standard crontab: `minute hour day-of-month month day-of-week`, with
//! day-of-week `0`-`7` where both `0` and `7` are Sunday and `1-5` is Monday to
//! Friday.
//!
//! The `cron` crate does not. It numbers days `1`-`7` starting at Sunday, so
//! handing it a crontab expression unchanged ran `1-5` Sunday to Thursday and
//! rejected `0` outright — a job scheduled for Sunday parsed as an error and
//! never fired. This module is the one place the two notations meet.

use cron::Schedule;
use std::str::FromStr;

/// Parse a standard 5-field crontab expression into a schedule.
pub fn parse(expr: &str) -> Result<Schedule, String> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(format!(
            "expected 5 fields (minute hour day-of-month month day-of-week), got {}",
            fields.len()
        ));
    }
    let day_of_week = day_of_week_for_crate(fields[4])?;
    // The crate takes 7 fields: seconds first, year last.
    let full = format!(
        "0 {} {} {} {} {} *",
        fields[0], fields[1], fields[2], fields[3], day_of_week
    );
    Schedule::from_str(&full).map_err(|e| e.to_string())
}

/// Reject a cron-kind schedule whose expression cannot be parsed.
///
/// Without this a typo is accepted, the job is stored with no next run, and it
/// sits in the list looking scheduled while never firing. Other schedule kinds
/// are left to the scheduler.
pub fn validate_schedule(schedule: &super::types::CronSchedule) -> Result<(), String> {
    if schedule.kind != super::types::ScheduleKind::Cron {
        return Ok(());
    }
    let expr = schedule
        .expr
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .ok_or_else(|| "A cron schedule needs an expression".to_string())?;
    parse(expr)
        .map(|_| ())
        .map_err(|e| format!("Invalid cron expression '{expr}': {e}"))
}

/// Rewrite a crontab day-of-week field in the `cron` crate's numbering.
///
/// The field is expanded to the set of days it names and written back as a
/// list. Shifting each number in place would not do: `5-7` (Friday to Sunday)
/// would become `6-1`, a range the crate rejects.
fn day_of_week_for_crate(field: &str) -> Result<String, String> {
    // Crontab day, 0 = Sunday .. 6 = Saturday.
    let mut days = [false; 7];
    for part in field.split(',') {
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => {
                let step: usize = step
                    .parse()
                    .ok()
                    .filter(|s| *s > 0)
                    .ok_or_else(|| format!("invalid day-of-week step in '{part}'"))?;
                (range, Some(step))
            }
            None => (part, None),
        };

        let (start, end) = if range == "*" || range == "?" {
            (0, 6)
        } else if let Some((a, b)) = range.split_once('-') {
            (day_number(a, part)?, day_number(b, part)?)
        } else {
            let day = day_number(range, part)?;
            // `3/2` means "from Wednesday to the end of the week, every 2".
            (day, if step.is_some() { 6 } else { day })
        };

        // A range may run past Saturday: `5-7` ends on Sunday, and `6-1`
        // (Saturday to Monday) wraps.
        let span = if end >= start {
            end - start
        } else {
            end + 7 - start
        };
        for offset in (0..=span).step_by(step.unwrap_or(1)) {
            days[(start + offset) % 7] = true;
        }
    }

    if days.iter().all(|d| *d) {
        return Ok("*".to_string());
    }
    // Crate numbering: 1 = Sunday .. 7 = Saturday.
    Ok(days
        .iter()
        .enumerate()
        .filter(|(_, on)| **on)
        .map(|(day, _)| (day + 1).to_string())
        .collect::<Vec<_>>()
        .join(","))
}

/// A crontab day as 0 (Sunday) .. 7 (Sunday again), from a number or a name.
fn day_number(token: &str, part: &str) -> Result<usize, String> {
    if let Ok(n) = token.parse::<usize>() {
        if n <= 7 {
            return Ok(n);
        }
        return Err(format!("day-of-week {n} is out of range 0-7 in '{part}'"));
    }
    match token.to_ascii_lowercase().as_str() {
        "sun" | "sunday" => Ok(0),
        "mon" | "monday" => Ok(1),
        "tue" | "tues" | "tuesday" => Ok(2),
        "wed" | "wednesday" => Ok(3),
        "thu" | "thurs" | "thursday" => Ok(4),
        "fri" | "friday" => Ok(5),
        "sat" | "saturday" => Ok(6),
        _ => Err(format!("invalid day-of-week '{token}' in '{part}'")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Datelike, TimeZone, Utc, Weekday};

    /// The weekdays an expression fires on, over the week after a fixed anchor.
    fn weekdays(expr: &str) -> Vec<Weekday> {
        let schedule = parse(expr).unwrap_or_else(|e| panic!("{expr}: {e}"));
        // 2024-06-01 is a Saturday; the next 7 days cover each weekday once.
        let anchor = Utc.with_ymd_and_hms(2024, 6, 1, 23, 59, 59).unwrap();
        let end = anchor + chrono::Duration::days(7);
        let mut seen: Vec<Weekday> = schedule
            .after(&anchor)
            .take_while(|at| *at <= end)
            .map(|at| at.weekday())
            .collect();
        seen.dedup();
        seen
    }

    #[test]
    fn one_to_five_is_monday_to_friday() {
        assert_eq!(
            weekdays("0 9 * * 1-5"),
            vec![
                Weekday::Mon,
                Weekday::Tue,
                Weekday::Wed,
                Weekday::Thu,
                Weekday::Fri
            ]
        );
    }

    #[test]
    fn zero_and_seven_are_both_sunday() {
        assert_eq!(weekdays("0 9 * * 0"), vec![Weekday::Sun]);
        assert_eq!(weekdays("0 9 * * 7"), vec![Weekday::Sun]);
    }

    #[test]
    fn ranges_reaching_sunday_work() {
        // Sunday first: the anchor week starts on a Sunday.
        assert_eq!(
            weekdays("0 9 * * 5-7"),
            vec![Weekday::Sun, Weekday::Fri, Weekday::Sat]
        );
        assert_eq!(weekdays("0 9 * * 6,0"), vec![Weekday::Sun, Weekday::Sat]);
    }

    #[test]
    fn names_and_steps_are_accepted() {
        assert_eq!(
            weekdays("0 9 * * mon,WED,Fri"),
            vec![Weekday::Mon, Weekday::Wed, Weekday::Fri]
        );
        assert_eq!(
            weekdays("0 9 * * 1-5/2"),
            vec![Weekday::Mon, Weekday::Wed, Weekday::Fri]
        );
    }

    #[test]
    fn every_day_stays_a_wildcard() {
        assert_eq!(day_of_week_for_crate("*").unwrap(), "*");
        assert_eq!(day_of_week_for_crate("0-6").unwrap(), "*");
        assert_eq!(weekdays("30 18 * * *").len(), 7);
    }

    #[test]
    fn bad_expressions_are_rejected() {
        assert!(parse("not a cron expr").is_err());
        assert!(parse("0 9 * *").is_err());
        assert!(parse("0 9 * * 8").is_err());
        assert!(parse("0 9 * * 1-5/0").is_err());
        assert!(parse("61 9 * * 1").is_err());
    }
}
