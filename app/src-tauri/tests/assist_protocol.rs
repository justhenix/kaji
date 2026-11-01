use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};

#[test]
fn collaboration_protocol_denies_actions_and_revokes_unstarted_work() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_kaji-assist"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    let mut request = |id: u64, command: Value| {
        let mut command = command;
        command["id"] = json!(id);
        writeln!(input, "{command}").unwrap();
        input.flush().unwrap();
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        let result: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(result["id"], id);
        result["result"].clone()
    };
    let status = request(1, json!({"command":"status"}));
    assert_eq!(status["Ok"]["phase"], "stopped");
    assert!(
        request(2, json!({"command":"invoke","session":0,"revision":1}))["Err"]
            .as_str()
            .unwrap()
            .contains("--enable-actions")
    );
    let stop = request(3, json!({"command":"stop"}));
    assert!(stop["Ok"]["session"].as_u64().unwrap() > 0);
    assert!(
        request(
            4,
            json!({"command":"point","session":0,"element_id":"stale"})
        )["Err"]
            .as_str()
            .unwrap()
            .contains("session unavailable")
    );
    assert!(
        request(5, json!({"command":"pause"}))["Err"]
            .as_str()
            .unwrap()
            .contains("no active session")
    );
    request(6, json!({"command":"shutdown"}));
    drop(input);
    assert!(child.wait().unwrap().success());
}
