use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn diagnostic_requests_preserve_ids_and_deny_input_by_default() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_kaji-diag"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdin = child.stdin.as_mut().unwrap();
    for request in [
        r#"{"id":1,"command":"status"}"#,
        r#"{"id":2,"command":"resolve","element_id":"unknown"}"#,
        r#"{"id":3,"command":"begin"}"#,
        r#"{"id":5,"command":"not_a_command"}"#,
        r#"{"id":4,"command":"shutdown"}"#,
    ] {
        writeln!(stdin, "{request}").unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let replies: String = String::from_utf8(output.stdout).unwrap();
    let replies: Vec<serde_json::Value> = replies
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(replies.len(), 5);
    let find = |id: u64| replies.iter().find(|r| r["id"] == id).unwrap();
    assert_eq!(find(1)["result"]["Ok"]["phase"], "stopped");
    assert!(
        find(2)["result"]["Err"]
            .as_str()
            .unwrap()
            .contains("unknown")
    );
    assert!(
        find(3)["result"]["Err"]
            .as_str()
            .unwrap()
            .contains("--enable-input")
    );
    assert_eq!(find(4)["result"]["Ok"]["phase"], "stopped");
    assert!(find(5)["result"].get("Err").is_some());
}
