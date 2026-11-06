use crate::uia::Action;

#[derive(Clone, Copy)]
pub enum ReviewPolicy {
    Auto,
    FullAccess,
}

pub fn requires_confirmation(
    action: &Action,
    name: &str,
    automation_id: &str,
    control_type: i32,
) -> bool {
    let label = name.to_lowercase();
    let context = format!("{label} {}", automation_id.to_lowercase());
    if matches!(action, Action::Scroll { .. })
        || matches!(action, Action::Invoke {}) && matches!(control_type, 50019 | 50024)
    {
        return false;
    }
    let words: Vec<_> = context
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    if words.iter().any(|word| {
        matches!(
            *word,
            "delete"
                | "remove"
                | "erase"
                | "wipe"
                | "purge"
                | "format"
                | "uninstall"
                | "discard"
                | "send"
                | "post"
                | "publish"
                | "share"
                | "upload"
                | "invite"
                | "transfer"
                | "pay"
                | "payment"
                | "payments"
                | "buy"
                | "purchase"
                | "checkout"
                | "order"
                | "subscribe"
                | "donate"
                | "password"
                | "credential"
                | "secret"
                | "token"
                | "security"
                | "privacy"
                | "permission"
                | "administrator"
                | "firewall"
                | "certificate"
                | "encrypt"
                | "decrypt"
                | "billing"
                | "card"
                | "install"
                | "execute"
                | "run"
                | "allow"
                | "authorize"
                | "grant"
                | "accept"
                | "agree"
                | "submit"
                | "confirm"
                | "approve"
                | "commit"
                | "deploy"
                | "merge"
                | "overwrite"
                | "replace"
                | "hapus"
                | "kirim"
                | "bayar"
                | "beli"
                | "bagikan"
                | "unggah"
                | "izinkan"
                | "sandi"
        )
    }) {
        return true;
    }
    match action {
        Action::Scroll { .. } | Action::Select {} => false,
        Action::SetValue { .. } => false,
        Action::SetToggle { .. } => !matches!(
            label.trim(),
            "word wrap" | "wrap text" | "bold" | "italic" | "underline" | "dark mode"
        ),
        Action::Invoke {} => {
            let label = label.trim();
            let routine_label = [
                "new tab",
                "new window",
                "back",
                "forward",
                "refresh",
                "reload",
                "home",
                "open",
                "close tab",
                "minimize",
                "maximize",
                "restore",
                "copy",
                "paste",
                "cut",
                "undo",
                "redo",
                "select",
                "find",
                "search",
                "zoom",
                "next",
                "previous",
                "cancel",
                "file explorer",
                "calculator",
            ]
            .iter()
            .any(|prefix| {
                label == *prefix
                    || label
                        .strip_prefix(prefix)
                        .is_some_and(|tail| tail.starts_with([' ', '(', ',']))
            });
            let calculator_key = !label.is_empty()
                && label
                    .chars()
                    .all(|c| c.is_ascii_digit() || "+−-×*/÷=.,%".contains(c));
            !(routine_label || calculator_key || automation_id.starts_with("Appid: "))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routine_navigation_and_editing_do_not_interrupt() {
        for label in [
            "New Tab",
            "New tab (Ctrl+T)",
            "Back",
            "Copy",
            "Open File",
            "7",
            "File Explorer - 1 running window pinned",
        ] {
            assert!(
                !requires_confirmation(&Action::Invoke {}, label, "", 50000),
                "{label}"
            );
        }
        assert!(!requires_confirmation(
            &Action::SetValue {
                value: "hello".into()
            },
            "Search",
            "search-box",
            50004
        ));
        assert!(!requires_confirmation(
            &Action::Invoke {},
            "Project notes",
            "",
            50024
        ));
    }
    #[test]
    fn consequential_or_unclear_actions_require_review() {
        for label in [
            "Delete file",
            "Send",
            "Pay now",
            "Share",
            "Upload",
            "Allow microphone",
            "Accept terms",
            "Run",
            "OK",
            "Continue",
            "Yes",
            "Open payment",
            "Open privacy settings",
            "Hapus",
            "Kirim",
        ] {
            assert!(
                requires_confirmation(&Action::Invoke {}, label, "", 50000),
                "{label}"
            );
        }
        assert!(requires_confirmation(
            &Action::SetValue {
                value: "secret".into()
            },
            "API token",
            "",
            50004
        ));
        assert!(requires_confirmation(
            &Action::SetToggle { on: false },
            "Firewall",
            "",
            50002
        ));
        assert!(requires_confirmation(
            &Action::Invoke {},
            "New Tab",
            "delete-account",
            50000
        ));
    }
}
