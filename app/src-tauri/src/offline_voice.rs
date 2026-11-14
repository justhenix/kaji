use crate::voice_commands::normalize;
use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
struct Phrase {
    id: String,
    en: String,
    idn: String,
}

pub struct Clip {
    pub text: &'static str,
    pub audio: &'static [u8],
}

fn phrases() -> &'static [Phrase] {
    static PHRASES: OnceLock<Vec<Phrase>> = OnceLock::new();
    PHRASES.get_or_init(|| {
        serde_json::from_str(include_str!("../../assets/voice/manifest.json"))
            .expect("bundled voice manifest must be valid")
    })
}

pub fn clip(id: &str, indonesian: bool) -> Option<Clip> {
    macro_rules! audio {
        ($id:literal) => {
            if indonesian {
                include_bytes!(concat!("../../assets/voice/idn/", $id, ".mp3")).as_slice()
            } else {
                include_bytes!(concat!("../../assets/voice/en/", $id, ".mp3")).as_slice()
            }
        };
    }
    let audio = match id {
        "ready" => audio!("ready"),
        "sorry" => audio!("sorry"),
        "acknowledged" => audio!("acknowledged"),
        "anything_else" => audio!("anything_else"),
        "voice_test" => audio!("voice_test"),
        "agent_mode" => audio!("agent_mode"),
        "assist_mode" => audio!("assist_mode"),
        "guide_mode" => audio!("guide_mode"),
        "light_mode" => audio!("light_mode"),
        "dark_mode" => audio!("dark_mode"),
        "system_mode" => audio!("system_mode"),
        _ => return None,
    };
    let phrase = phrases().iter().find(|phrase| phrase.id == id)?;
    Some(Clip {
        text: if indonesian { &phrase.idn } else { &phrase.en },
        audio,
    })
}

pub fn find(text: &str) -> Option<Clip> {
    let normalized = normalize(text);
    for phrase in phrases() {
        if normalize(&phrase.en) == normalized {
            return clip(&phrase.id, false);
        }
        if normalize(&phrase.idn) == normalized {
            return clip(&phrase.id, true);
        }
    }
    let id = match normalized.as_str() {
        "ready" | "i'm ready" | "i am ready" => "ready",
        "sorry" | "i'm sorry" => "sorry",
        "i will do it" | "will do" | "on it" | "i'll do that" => "acknowledged",
        "anything else" | "what else do you need" => "anything_else",
        "agent mode activated" | "agent mode selected" => "agent_mode",
        "assist mode selected" => "assist_mode",
        "guide mode selected" => "guide_mode",
        "light mode activated" | "light theme activated" => "light_mode",
        "dark theme activated" => "dark_mode",
        "system theme activated" => "system_mode",
        _ => return None,
    };
    clip(id, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_manifest_phrase_has_bundled_audio_in_both_languages() {
        for phrase in phrases() {
            for indonesian in [false, true] {
                let clip = clip(&phrase.id, indonesian).unwrap();
                assert!(clip.audio.len() > 1_000, "{} has empty audio", phrase.id);
                assert_eq!(find(clip.text).unwrap().audio, clip.audio);
            }
        }
        assert_eq!(find("READY!").unwrap().text, "Ready when you are.");
        assert_eq!(find("I will do it").unwrap().text, "I'll do it.");
        assert_eq!(find("I’ll do it.").unwrap().text, "I'll do it.");
        assert!(find("Ready to delete your files").is_none());
        assert!(find("What else do you need? I found a problem.").is_none());
    }
}
