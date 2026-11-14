use crate::assist::Mode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Mode(Mode),
    Theme(&'static str),
    Dwell(bool),
    Head(bool),
    ComposerPosition(&'static str),
    VoiceFeedback(bool),
    ResponseVolume(u32),
    Reply(&'static str),
}

pub fn normalize(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| match c {
            '’' => '\'',
            _ if c.is_alphanumeric() || matches!(c, '\'' | '-') => c,
            _ => ' ',
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn parse_spoken(text: &str) -> Option<Command> {
    // Whisper can hear the app's "agent mode" as "agile mode".
    parse(
        &normalize(text)
            .replace("agile mode", "agent mode")
            .replace("mode agile", "mode agent")
            .replace("joel list", "dwell"),
    )
}

pub fn parse(text: &str) -> Option<Command> {
    let normalized = normalize(text);
    let mut text = normalized.as_str();
    for prefix in [
        "hey kaji ",
        "hi kaji ",
        "hello kaji ",
        "kaji ",
        "hai kaji ",
        "halo kaji ",
    ] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest;
            break;
        }
    }
    for prefix in [
        "please ",
        "tolong ",
        "can you ",
        "could you ",
        "would you ",
        "bisa kamu ",
        "bisakah kamu ",
    ] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest;
        }
    }
    text = text.strip_prefix("please ").unwrap_or(text);
    for suffix in [" please", " for me", " now", " sekarang", " ya"] {
        text = text.strip_suffix(suffix).unwrap_or(text);
    }

    let reply = match text {
        "hey kaji" | "hi kaji" | "hello kaji" | "kaji" | "hai kaji" | "halo kaji" | "hi"
        | "hello" | "hey" | "ready" | "are you ready" | "are you there" | "halo" | "hai"
        | "siap" | "sudah siap" | "kamu siap" => Some("ready"),
        "sorry" | "maaf" => Some("sorry"),
        "thank you" | "thanks" | "thanks kaji" | "thank you kaji" | "terima kasih" | "makasih" => {
            Some("anything_else")
        }
        "test" | "testing" | "voice test" | "test voice" | "test your voice" | "test audio"
        | "test your audio" | "test sound" | "tes suara" | "uji suara" => Some("voice_test"),
        _ => None,
    };
    if let Some(reply) = reply {
        return Some(Command::Reply(reply));
    }

    if let Some(volume) = text
        .strip_prefix("set response volume to ")
        .or_else(|| text.strip_prefix("set your response volume to "))
        .and_then(parse_percent)
    {
        return Some(Command::ResponseVolume(volume));
    }
    match text {
        "read replies aloud" | "turn on spoken feedback" | "enable spoken feedback" => {
            return Some(Command::VoiceFeedback(true));
        }
        "stop reading replies aloud" | "turn off spoken feedback" | "disable spoken feedback" => {
            return Some(Command::VoiceFeedback(false));
        }
        _ => {}
    }

    for (target, head) in [
        ("dwell", false),
        ("dwell clicking", false),
        ("dwell click", false),
        ("head control", true),
        ("head tracking", true),
        ("kontrol kepala", true),
    ] {
        for (enabled, prefixes, suffix) in [
            (
                true,
                &[
                    "turn on ",
                    "switch on ",
                    "enable ",
                    "activate ",
                    "start ",
                    "aktifkan ",
                ][..],
                "on",
            ),
            (
                false,
                &[
                    "turn off ",
                    "switch off ",
                    "disable ",
                    "deactivate ",
                    "stop ",
                    "matikan ",
                ][..],
                "off",
            ),
        ] {
            if prefixes.iter().any(|prefix| {
                text == format!("{prefix}{target}") || text == format!("{prefix}the {target}")
            }) || text == format!("turn {target} {suffix}")
                || text == format!("turn the {target} {suffix}")
            {
                return Some(if head {
                    Command::Head(enabled)
                } else {
                    Command::Dwell(enabled)
                });
            }
        }
    }

    if let Some(target) = [
        "use ",
        "switch to ",
        "move to ",
        "put the command bar position in the ",
        "put the command bar in the ",
        "put the command bar in ",
        "move the command bar to ",
        "set command bar position to ",
        "set the command bar position to ",
        "change the command bar position to ",
        "dock the command bar ",
    ]
    .iter()
    .find_map(|prefix| text.strip_prefix(prefix))
    {
        let position = match target.strip_prefix("the ").unwrap_or(target) {
            "top island" | "at the top" => Some("top"),
            "floating window" => Some("floating"),
            "taskbar dock" | "to the taskbar" | "on the taskbar" => Some("taskbar"),
            _ => None,
        };
        if let Some(position) = position {
            return Some(Command::ComposerPosition(position));
        }
    }

    for (name, mode) in [
        ("agent", Mode::Agent),
        ("assist", Mode::Assist),
        ("guide", Mode::Guide),
        ("agen", Mode::Agent),
        ("bantuan", Mode::Assist),
        ("panduan", Mode::Guide),
    ] {
        for target in [format!("{name} mode"), format!("mode {name}")] {
            if text == target
                || [
                    "use ",
                    "switch to ",
                    "switch into ",
                    "change to ",
                    "change into ",
                    "set ",
                    "set mode to ",
                    "enable ",
                    "activate ",
                    "enter ",
                    "go to ",
                    "ganti ke ",
                    "ubah ke ",
                    "gunakan ",
                    "aktifkan ",
                    "masuk ke ",
                ]
                .iter()
                .any(|prefix| text.strip_prefix(prefix) == Some(target.as_str()))
            {
                return Some(Command::Mode(mode));
            }
        }
    }

    for (names, theme) in [
        (&["light", "white", "terang", "putih"][..], "light"),
        (&["dark", "black", "gelap", "hitam"][..], "dark"),
        (&["system", "automatic", "sistem", "otomatis"][..], "system"),
    ] {
        for name in names {
            for target in [
                format!("{name} mode"),
                format!("{name} theme"),
                format!("mode {name}"),
                format!("tema {name}"),
                name.to_string(),
            ] {
                if (text == target && target != *name)
                    || [
                        "use ",
                        "switch to ",
                        "change to ",
                        "change into ",
                        "enable ",
                        "activate ",
                        "turn on ",
                        "set theme to ",
                        "set your theme to ",
                        "change theme to ",
                        "change your theme to ",
                        "change appearance to ",
                        "change appearance into ",
                        "change your appearance to ",
                        "change your appearance into ",
                        "set appearance to ",
                        "set your appearance to ",
                        "ganti ke ",
                        "ubah ke ",
                        "gunakan ",
                        "aktifkan ",
                        "ubah tampilan ke ",
                        "ganti tampilan ke ",
                        "ubah temamu ke ",
                        "ubah tampilanmu ke ",
                    ]
                    .iter()
                    .any(|prefix| text.strip_prefix(prefix) == Some(target.as_str()))
                {
                    return Some(Command::Theme(theme));
                }
            }
        }
    }
    None
}

fn parse_percent(text: &str) -> Option<u32> {
    let value = text.strip_suffix(" percent").unwrap_or(text);
    if let Ok(number) = value.parse::<u32>() {
        return (number <= 100).then_some(number);
    }
    const UNITS: [&str; 10] = [
        "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    ];
    const TEENS: [&str; 10] = [
        "ten",
        "eleven",
        "twelve",
        "thirteen",
        "fourteen",
        "fifteen",
        "sixteen",
        "seventeen",
        "eighteen",
        "nineteen",
    ];
    const TENS: [&str; 8] = [
        "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
    ];
    if value == "one hundred" {
        return Some(100);
    }
    if let Some(unit) = UNITS.iter().position(|word| *word == value) {
        return Some(unit as u32);
    }
    if let Some(teen) = TEENS.iter().position(|word| *word == value) {
        return Some(10 + teen as u32);
    }
    let (tens, units) = value.split_once([' ', '-']).unwrap_or((value, "zero"));
    let tens = TENS.iter().position(|word| *word == tens)? as u32;
    let units = UNITS.iter().position(|word| *word == units)? as u32;
    Some(20 + tens * 10 + units)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spoken_app_controls_accept_wake_words_and_politeness() {
        for (text, expected) in [
            (
                "Hey Kaji, can you use agent mode please?",
                Command::Mode(Mode::Agent),
            ),
            (
                "Could you switch to guide mode?",
                Command::Mode(Mode::Guide),
            ),
            ("Please activate assist mode.", Command::Mode(Mode::Assist)),
            (
                "Hey Kaji change your appearance into white mode",
                Command::Theme("light"),
            ),
            (
                "Kaji, please set your theme to dark.",
                Command::Theme("dark"),
            ),
            ("Use system theme please", Command::Theme("system")),
            (
                "Kaji, tolong aktifkan mode agen",
                Command::Mode(Mode::Agent),
            ),
            ("Ubah tampilan ke tema putih", Command::Theme("light")),
            ("Hey Kaji!", Command::Reply("ready")),
            (
                "Can you test your voice please?",
                Command::Reply("voice_test"),
            ),
            ("Terima kasih", Command::Reply("anything_else")),
        ] {
            assert_eq!(parse(text), Some(expected), "{text}");
        }
    }

    #[test]
    fn ordinary_requests_and_negative_or_compound_commands_stay_with_agent() {
        for text in [
            "What is agent mode?",
            "Don't use agent mode",
            "Can you explain dark mode?",
            "Switch to agent mode and open Word",
            "Write a guide about white mode",
            "Tell me you're ready",
            "Type 'use agent mode' into Notepad",
            "Use agent mode? No thanks.",
            "Change the website to dark mode",
            "white",
            "approve",
            "reject",
            "I'll do it",
        ] {
            assert_eq!(parse(text), None, "{text}");
        }
    }

    #[test]
    fn spoken_mode_correction_is_limited_to_the_observed_transcription_error() {
        assert_eq!(
            parse_spoken("Use agile mode, please."),
            Some(Command::Mode(Mode::Agent))
        );
        assert_eq!(parse("Use agile mode, please."), None);
        assert_eq!(parse_spoken("Explain agile mode"), None);
        assert_eq!(parse_spoken("Don't use agile mode"), None);
        assert_eq!(
            parse_spoken("Can you turn on the JOEL list?"),
            Some(Command::Dwell(true))
        );
        assert_eq!(parse("Can you turn on the JOEL list?"), None);
        assert_eq!(parse_spoken("Write about the JOEL list"), None);
        assert_eq!(
            parse("Hey Kaji, turn on dwell please"),
            Some(Command::Dwell(true))
        );
        assert_eq!(
            parse("Turn the head control off"),
            Some(Command::Head(false))
        );
        assert_eq!(
            parse("Can you put the command bar position in the top island?"),
            Some(Command::ComposerPosition("top"))
        );
        assert_eq!(parse("Don't turn on dwell"), None);
    }

    #[test]
    fn app_audio_and_position_commands_require_supported_targets() {
        for (phrase, expected) in [
            (
                "Move the command bar to the taskbar dock",
                Command::ComposerPosition("taskbar"),
            ),
            (
                "Change the command bar position to floating window",
                Command::ComposerPosition("floating"),
            ),
            ("Turn off spoken feedback", Command::VoiceFeedback(false)),
            ("Read replies aloud", Command::VoiceFeedback(true)),
            (
                "Set response volume to fifty percent",
                Command::ResponseVolume(50),
            ),
            ("Set response volume to 25%", Command::ResponseVolume(25)),
            (
                "Set your response volume to seventy-five percent",
                Command::ResponseVolume(75),
            ),
        ] {
            assert_eq!(parse_spoken(phrase), Some(expected), "{phrase}");
        }
        for phrase in [
            "Set response volume to 200%",
            "Set Windows volume to 50%",
            "Turn off privacy settings",
            "Move the Windows taskbar",
            "Set response volume to -25%",
        ] {
            assert_eq!(parse_spoken(phrase), None, "{phrase}");
        }
    }
}
