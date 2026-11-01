use kaji_engine::{
    control::{Config, Frame},
    engine::Engine,
};
use std::time::{Duration, Instant};
use windows::Win32::UI::Input::KeyboardAndMouse::*;

fn wait_stopped(engine: &Engine, reason: &str) {
    let start = Instant::now();
    loop {
        let state = engine.status().unwrap();
        if state.phase == "stopped" {
            assert!(state.reason.contains(reason), "{}", state.reason);
            assert!(start.elapsed() < Duration::from_millis(150));
            return;
        }
        assert!(
            start.elapsed() < Duration::from_millis(150),
            "native stop did not arrive: {state:?}"
        );
        std::thread::sleep(Duration::from_millis(3));
    }
}
#[test]
#[ignore = "requires unlocked Windows desktop; injects Escape and a one-pixel foreign mouse movement"]
fn live_hooks_watchdog_face_loss_and_stop_barrier() {
    let engine = Engine::new(true).unwrap();
    let config = Config {
        dwell_ms: 5000,
        ..Default::default()
    };
    let calibrate = |engine: &Engine| {
        let session = engine.begin(config.clone(), None).unwrap();
        let mut seq = 0;
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(1150) {
            std::thread::sleep(Duration::from_millis(35));
            seq += 1;
            engine
                .submit(Frame {
                    session: session.id,
                    sequence: seq,
                    captured_ms: engine.now_ms(),
                    yaw: 0.,
                    pitch: 0.,
                    faces: 1,
                    candidates: None,
                })
                .unwrap();
        }
        assert_eq!(engine.status().unwrap().phase, "tracking");
        (session, seq)
    };
    let (_session, _seq) = calibrate(&engine);
    let down = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_ESCAPE,
                ..Default::default()
            },
        },
    };
    let up = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VK_ESCAPE,
                dwFlags: KEYEVENTF_KEYUP,
                ..Default::default()
            },
        },
    };
    assert_eq!(
        unsafe { SendInput(&[down, up], std::mem::size_of::<INPUT>() as i32) },
        2
    );
    wait_stopped(&engine, "emergency stop");
    println!("PASS: real Windows Escape hook stopped native execution");
    std::thread::sleep(Duration::from_millis(40));
    let _ = engine.begin(config.clone(), None).unwrap();
    let motion = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx: 1,
                dy: 0,
                dwFlags: MOUSEEVENTF_MOVE,
                ..Default::default()
            },
        },
    };
    assert_eq!(
        unsafe { SendInput(&[motion], std::mem::size_of::<INPUT>() as i32) },
        1
    );
    wait_stopped(&engine, "manual takeover");
    println!("PASS: foreign mouse input stopped native execution");
    std::thread::sleep(Duration::from_millis(40));
    for faces in [0, 2] {
        let (session, seq) = calibrate(&engine);
        engine
            .submit(Frame {
                session: session.id,
                sequence: seq + 1,
                captured_ms: engine.now_ms(),
                yaw: 0.,
                pitch: 0.,
                faces,
                candidates: None,
            })
            .unwrap();
        wait_stopped(&engine, "face lost or multiple faces");
    }
    println!("PASS: face loss and multiple faces invalidate native sessions");
    let session = engine.begin(config.clone(), None).unwrap();
    engine
        .submit(Frame {
            session: session.id,
            sequence: 1,
            captured_ms: engine.now_ms(),
            yaw: 0.,
            pitch: 0.,
            faces: 1,
            candidates: None,
        })
        .unwrap();
    std::thread::sleep(Duration::from_millis(300));
    wait_stopped(&engine, "heartbeat");
    println!("PASS: watchdog stopped without sensor callbacks");
    let session = engine.begin(config.clone(), None).unwrap();
    let operator = kaji_engine::face::Face {
        yaw: 0.,
        pitch: 0.4,
        center_x: 0.5,
        center_y: 0.5,
        eye_span: 0.2,
    };
    let painting = kaji_engine::face::Face {
        center_x: 0.15,
        center_y: 0.25,
        eye_span: 0.055,
        ..operator
    };
    let mut sequence = 0;
    let mut send_candidates = |candidates: Vec<kaji_engine::face::Face>| {
        sequence += 1;
        engine
            .submit(Frame {
                session: session.id,
                sequence,
                captured_ms: engine.now_ms(),
                yaw: 0.,
                pitch: 0.,
                faces: candidates.len() as u8,
                candidates: Some(candidates),
            })
            .unwrap();
    };
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(1200) {
        std::thread::sleep(Duration::from_millis(35));
        send_candidates(vec![operator, painting]);
    }
    assert_eq!(engine.status().unwrap().phase, "tracking");
    send_candidates(vec![painting]);
    std::thread::sleep(Duration::from_millis(25));
    assert_eq!(engine.status().unwrap().phase, "no_face");
    let paused = engine.status().unwrap();
    assert_eq!(paused.moves, 0);
    assert_eq!(paused.clicks, 0);
    send_candidates(vec![operator, painting]);
    std::thread::sleep(Duration::from_millis(25));
    let resumed = engine.status().unwrap();
    assert_eq!(resumed.phase, "tracking");
    assert_eq!(resumed.moves, 0);
    assert_eq!(resumed.clicks, 0);
    println!("PASS: foreground-plus-painting tracking, safe pause, and same-operator recovery");
    engine.stop("cancelled sensor startup").unwrap();
    assert!(engine.begin_sensor(config.clone(), None).is_err());
    println!("PASS: late sensor initialization cannot rearm a cancelled native session");
    let session = engine.begin(config, None).unwrap();
    let stopped = engine.stop("stop barrier test").unwrap();
    for seq in 1..100 {
        assert!(
            engine
                .submit(Frame {
                    session: session.id,
                    sequence: seq,
                    captured_ms: engine.now_ms(),
                    yaw: -0.3,
                    pitch: 0.,
                    faces: 1,
                    candidates: None
                })
                .is_err()
        );
    }
    std::thread::sleep(Duration::from_millis(60));
    let after = engine.status().unwrap();
    assert_eq!(after.moves, stopped.moves);
    assert_eq!(after.clicks, 0);
    println!("PASS: stop barrier rejects queued session work; zero clicks in safety tests");
}
