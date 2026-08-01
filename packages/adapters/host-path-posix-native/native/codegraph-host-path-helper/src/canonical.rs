use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::protocol::HelperError;

pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;

/// ABI 只允许可稳定规范化的 JSON 子集，拒绝浮点、重复字段后的非规范表示与未知尾随字节。
pub fn canonical_json<T: Serialize>(value: &T) -> Result<Vec<u8>, HelperError> {
    let value = serde_json::to_value(value).map_err(|_| HelperError::protocol("ABI_SERIALIZE"))?;
    let mut output = Vec::new();
    write_value(&value, &mut output)?;
    Ok(output)
}

pub fn canonical_sha256<T: Serialize>(value: &T) -> Result<String, HelperError> {
    Ok(hex::encode(Sha256::digest(canonical_json(value)?)))
}

pub fn encode_frame<T: Serialize>(value: &T) -> Result<Vec<u8>, HelperError> {
    let payload = canonical_json(value)?;
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(HelperError::budget("FRAME_SIZE"));
    }
    let length = u32::try_from(payload.len()).map_err(|_| HelperError::budget("FRAME_SIZE"))?;
    let mut frame = Vec::with_capacity(payload.len() + 4);
    frame.extend_from_slice(&length.to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

pub fn decode_frame<T: serde::de::DeserializeOwned + Serialize>(frame: &[u8]) -> Result<T, HelperError> {
    if frame.len() < 5 {
        return Err(HelperError::protocol("FRAME_LENGTH"));
    }
    let declared = u32::from_be_bytes(frame[..4].try_into().expect("fixed prefix")) as usize;
    if declared == 0 || declared > MAX_FRAME_BYTES || frame.len() != declared + 4 {
        return Err(HelperError::protocol("FRAME_LENGTH"));
    }
    let payload = &frame[4..];
    if payload.contains(&0) || payload.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Err(HelperError::protocol("FRAME_ENCODING"));
    }
    let value: T = serde_json::from_slice(payload).map_err(|_| HelperError::protocol("FRAME_JSON"))?;
    if canonical_json(&value)? != payload {
        return Err(HelperError::protocol("FRAME_NOT_CANONICAL"));
    }
    Ok(value)
}

fn write_value(value: &Value, output: &mut Vec<u8>) -> Result<(), HelperError> {
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(value) => output.extend_from_slice(if *value { b"true" } else { b"false" }),
        Value::Number(value) => {
            if !value.is_i64() && !value.is_u64() {
                return Err(HelperError::protocol("ABI_FLOAT_FORBIDDEN"));
            }
            output.extend_from_slice(value.to_string().as_bytes());
        }
        Value::String(value) => {
            output.extend_from_slice(
                serde_json::to_string(value)
                    .map_err(|_| HelperError::protocol("ABI_STRING"))?
                    .as_bytes(),
            );
        }
        Value::Array(values) => {
            output.push(b'[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                write_value(value, output)?;
            }
            output.push(b']');
        }
        Value::Object(values) => {
            output.push(b'{');
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    output.push(b',');
                }
                output.extend_from_slice(
                    serde_json::to_string(key)
                        .map_err(|_| HelperError::protocol("ABI_KEY"))?
                        .as_bytes(),
                );
                output.push(b':');
                write_value(&values[key], output)?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};

    use super::{decode_frame, encode_frame};

    #[derive(Debug, Deserialize, PartialEq, Serialize)]
    #[serde(deny_unknown_fields)]
    struct Fixture {
        a: u64,
        b: u64,
    }

    #[test]
    fn length_prefix_and_canonical_order_are_strict() {
        let frame = encode_frame(&Fixture { a: 1, b: 2 }).expect("frame");
        assert_eq!(&frame[4..], br#"{"a":1,"b":2}"#);
        assert_eq!(decode_frame::<Fixture>(&frame).expect("decode"), Fixture { a: 1, b: 2 });

        let payload = br#"{"b":2,"a":1}"#;
        let mut non_canonical = Vec::from((payload.len() as u32).to_be_bytes());
        non_canonical.extend_from_slice(payload);
        assert_eq!(
            decode_frame::<Fixture>(&non_canonical).expect_err("must reject").code,
            "FRAME_NOT_CANONICAL"
        );
    }
}
