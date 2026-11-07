use crate::{Result, native};
use serde::Deserialize;
use serde_json::Value;
use std::ffi::c_void;
use std::sync::Mutex;
use windows::Win32::Networking::WinHttp::{
    WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_FLAG_SECURE, WINHTTP_OPTION_REDIRECT_POLICY,
    WINHTTP_OPTION_REDIRECT_POLICY_NEVER, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryDataAvailable,
    WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest,
    WinHttpSetOption, WinHttpSetTimeouts,
};

const MAX_STT_RESPONSE: usize = 64 * 1024;
const MAX_TITLE_RESPONSE: usize = 32 * 1024;
const MAX_CAPABILITY_RESPONSE: usize = 256 * 1024;
const MAX_TTS_RESPONSE: usize = 10 * 1024 * 1024;
static CONNECTED: Mutex<bool> = Mutex::new(false);

pub fn connected_token() -> Result<String> {
    let mut connected = CONNECTED
        .lock()
        .map_err(|_| "Device connection is unavailable")?;
    let mut token = match native::load_gateway_token() {
        Ok(token) => token,
        Err(error) if native::gateway_credential_path()?.exists() => return Err(error),
        Err(_) => {
            let token = native::new_device_token()?;
            native::save_gateway_token(&token)?;
            token
        }
    };
    if *connected {
        return Ok(token);
    }
    let response = request_with_token("GET", "/v1/devices/session", &[], 4096, &token)?;
    if response.status == 401 {
        if !token.starts_with("kd_") {
            wipe_string(&mut token);
            token = native::new_device_token()?;
        }
        let enrolled = request_with_token("POST", "/v1/devices/enroll", &[], 4096, &token)?;
        success_json(enrolled, "Automatic device setup")?;
        native::save_gateway_token(&token)?;
    } else {
        success_json(response, "Device connection")?;
    }
    *connected = true;
    Ok(token)
}

pub struct GatewayResponse {
    pub status: u32,
    pub body: Vec<u8>,
}

struct Handle(*mut c_void);
impl Handle {
    fn new(raw: *mut c_void, what: &str) -> Result<Self> {
        if raw.is_null() {
            return Err(format!("could not create gateway {what} handle"));
        }
        Ok(Self(raw))
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            let _ = WinHttpCloseHandle(self.0);
        }
    }
}

pub fn transcribe(wav_base64: &str, language: &str) -> Result<Transcript> {
    if wav_base64.is_empty() || wav_base64.len() > 3 * 1024 * 1024 {
        return Err("audio utterance exceeds gateway limit".into());
    }
    if !matches!(language, "en" | "id" | "auto") {
        return Err("speech language must be en, id, or auto".into());
    }
    let response = post_json(
        "/v1/audio/transcriptions",
        &serde_json::json!({ "wavBase64": wav_base64, "language": language }),
        MAX_STT_RESPONSE,
    )?;
    let value = success_json(response, "speech recognition")?;
    let transcript: Transcript =
        serde_json::from_value(value).map_err(|_| "speech gateway returned invalid transcript")?;
    if transcript.text.trim().is_empty() || transcript.text.len() > 8_000 {
        return Err("speech gateway returned empty or oversized transcript".into());
    }
    Ok(transcript)
}

pub fn title(request: &str, response: &str) -> Result<String> {
    if request.trim().is_empty() || request.len() > 4_000 || response.len() > 4_000 {
        return Err("title source is outside the gateway limit".into());
    }
    let result = post_json(
        "/v1/chat/titles",
        &serde_json::json!({ "request": request, "response": response }),
        MAX_TITLE_RESPONSE,
    )?;
    let value = success_json(result, "conversation title")?;
    let title = value
        .get("title")
        .and_then(Value::as_str)
        .ok_or("title gateway returned invalid response")?
        .trim();
    if title.chars().count() > 80 || title.is_empty() {
        return Err("title gateway returned an invalid title".into());
    }
    Ok(title.to_owned())
}

pub fn capabilities() -> Result<Value> {
    let response = request("GET", "/v1/capabilities", &[], MAX_CAPABILITY_RESPONSE)?;
    success_json(response, "service capabilities")
}

pub fn speech(text: &str, voice_id: Option<&str>) -> Result<Vec<u8>> {
    if text.trim().is_empty() || text.chars().count() > 1_000 {
        return Err("speech text must contain 1-1000 characters".into());
    }
    if voice_id.is_some_and(|id| {
        id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    }) {
        return Err("invalid speech voice id".into());
    }
    let mut body = serde_json::json!({ "text": text });
    if let Some(voice_id) = voice_id {
        body["voiceId"] = Value::String(voice_id.to_owned());
    }
    let response = post_json("/v1/audio/speech", &body, MAX_TTS_RESPONSE)?;
    if !(200..300).contains(&response.status) {
        return Err(service_error(
            &response.body,
            response.status,
            "speech synthesis",
        ));
    }
    if response.body.is_empty() {
        return Err("speech gateway returned empty audio".into());
    }
    Ok(response.body)
}

fn post_json(path: &str, body: &Value, response_limit: usize) -> Result<GatewayResponse> {
    let bytes = serde_json::to_vec(body).map_err(|e| e.to_string())?;
    request("POST", path, &bytes, response_limit)
}

fn request(
    method: &str,
    path: &str,
    body: &[u8],
    response_limit: usize,
) -> Result<GatewayResponse> {
    let mut token = connected_token()?;
    let mut result = request_with_token(method, path, body, response_limit, &token);
    if result.as_ref().is_ok_and(|response| response.status == 401) {
        *CONNECTED
            .lock()
            .map_err(|_| "Device connection is unavailable")? = false;
        wipe_string(&mut token);
        token = connected_token()?;
        result = request_with_token(method, path, body, response_limit, &token);
    }
    wipe_string(&mut token);
    result
}

fn request_with_token(
    method: &str,
    path: &str,
    body: &[u8],
    response_limit: usize,
    token: &str,
) -> Result<GatewayResponse> {
    if !matches!(method, "GET" | "POST") || !path.starts_with("/v1/") || path.contains(['?', '#']) {
        return Err("invalid gateway route".into());
    }
    let user_agent = windows::core::w!("Kaji");
    let session = Handle::new(
        unsafe {
            WinHttpOpen(
                user_agent,
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                windows::core::PCWSTR::null(),
                windows::core::PCWSTR::null(),
                0,
            )
        },
        "session",
    )?;
    unsafe { WinHttpSetTimeouts(session.0, 5000, 5000, 10_000, 60_000) }
        .map_err(|_| "gateway connection timed out")?;
    let host = windows::core::w!("kaji-gateway.relanta.workers.dev");
    let connection = Handle::new(
        unsafe { WinHttpConnect(session.0, host, 443, 0) },
        "connection",
    )?;
    let method_wide: Vec<u16> = method.encode_utf16().chain([0]).collect();
    let path_wide: Vec<u16> = path.encode_utf16().chain([0]).collect();
    let request = Handle::new(
        unsafe {
            WinHttpOpenRequest(
                connection.0,
                windows::core::PCWSTR(method_wide.as_ptr()),
                windows::core::PCWSTR(path_wide.as_ptr()),
                windows::core::PCWSTR::null(),
                windows::core::PCWSTR::null(),
                std::ptr::null(),
                WINHTTP_FLAG_SECURE,
            )
        },
        "request",
    )?;
    let redirect = WINHTTP_OPTION_REDIRECT_POLICY_NEVER.to_ne_bytes();
    unsafe {
        WinHttpSetOption(
            Some(request.0 as *const c_void),
            WINHTTP_OPTION_REDIRECT_POLICY,
            Some(&redirect),
        )
    }
    .map_err(|_| "gateway redirect policy could not be set")?;

    let mut header = format!(
        "Authorization: Bearer {token}\r\n{}\r\n",
        if method == "POST" {
            "Content-Type: application/json"
        } else {
            ""
        }
    );
    let mut headers: Vec<u16> = header.encode_utf16().chain([0]).collect();
    wipe_string(&mut header);
    let sent = unsafe {
        WinHttpSendRequest(
            request.0,
            Some(&headers[..headers.len().saturating_sub(1)]),
            (!body.is_empty()).then_some(body.as_ptr().cast()),
            body.len() as u32,
            body.len() as u32,
            0,
        )
    };
    wipe_wide(&mut headers);
    sent.map_err(|_| "gateway request could not be sent")?;
    unsafe { WinHttpReceiveResponse(request.0, std::ptr::null_mut()) }
        .map_err(|_| "gateway response unavailable")?;

    let mut status = 0u32;
    let mut status_bytes = std::mem::size_of::<u32>() as u32;
    unsafe {
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            windows::core::PCWSTR::null(),
            Some((&mut status as *mut u32).cast()),
            &mut status_bytes,
            std::ptr::null_mut(),
        )
    }
    .map_err(|_| "gateway response status unavailable")?;

    let mut output = Vec::new();
    loop {
        let mut available = 0u32;
        unsafe { WinHttpQueryDataAvailable(request.0, &mut available) }
            .map_err(|_| "gateway response read failed")?;
        if available == 0 {
            break;
        }
        if output.len().saturating_add(available as usize) > response_limit {
            return Err("gateway response exceeds size limit".into());
        }
        let old_len = output.len();
        output.resize(old_len + available as usize, 0);
        let mut read = 0u32;
        unsafe {
            WinHttpReadData(
                request.0,
                output[old_len..].as_mut_ptr().cast(),
                available,
                &mut read,
            )
        }
        .map_err(|_| "gateway response read failed")?;
        output.truncate(old_len + read as usize);
    }
    Ok(GatewayResponse {
        status,
        body: output,
    })
}

fn success_json(response: GatewayResponse, service: &str) -> Result<Value> {
    if !(200..300).contains(&response.status) {
        return Err(service_error(&response.body, response.status, service));
    }
    serde_json::from_slice(&response.body)
        .map_err(|_| format!("{service} returned invalid response"))
}

fn service_error(body: &[u8], status: u32, service: &str) -> String {
    let message = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| {
            let error = value.get("error")?;
            error
                .as_str()
                .or_else(|| error.get("message").and_then(Value::as_str))
                .map(str::to_owned)
        });
    if status == 429 {
        return format!("{service} quota exhausted");
    }
    message
        .filter(|text| text.len() <= 300)
        .map(|text| format!("{service}: {text}"))
        .unwrap_or_else(|| format!("{service} unavailable (HTTP {status})"))
}

fn wipe_string(value: &mut String) {
    unsafe {
        for byte in value.as_mut_vec() {
            std::ptr::write_volatile(byte, 0);
        }
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
    value.clear();
}

fn wipe_wide(value: &mut [u16]) {
    for unit in value {
        unsafe { std::ptr::write_volatile(unit, 0) };
    }
    std::sync::atomic::compiler_fence(std::sync::atomic::Ordering::SeqCst);
}

#[derive(Deserialize)]
pub struct Transcript {
    pub text: String,
    pub language: Option<String>,
}
