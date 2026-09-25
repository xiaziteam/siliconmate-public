use serde::{Deserialize, Serialize};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageProcessResult {
    pub path: String,
    pub name: String,
    pub ocr_text: Option<String>,
    pub ocr_status: String,
    pub file_size: u64,
}

const SWIFT_OCR: &str = r#"
import Vision
import Foundation
import ImageIO
import CoreGraphics

guard CommandLine.arguments.count > 1 else {
    fputs("ERROR:NO_PATH\n", stderr)
    exit(1)
}

let path = CommandLine.arguments[1]
let url = URL(fileURLWithPath: path)

guard let cgImageSource = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(cgImageSource, 0, nil) else {
    fputs("ERROR:LOAD_IMAGE\n", stderr)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en"]
request.usesLanguageCorrection = true

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

do {
    try handler.perform([request])
} catch {
    fputs("ERROR:VISION_PERFORM\n", stderr)
    exit(1)
}

guard let observations = request.results, !observations.isEmpty else {
    exit(0)
}

var lines: [String] = []
for obs in observations {
    if let candidate = obs.topCandidates(1).first {
        lines.append(candidate.string)
    }
}

let result = lines.joined(separator: "\n")
if !result.isEmpty {
    print(result)
}
"#;

fn ensure_ocr_tool() -> Result<std::path::PathBuf, String> {
    let tmp_dir = std::env::temp_dir().join("siliconmate-ocr");
    let _ = std::fs::create_dir_all(&tmp_dir);
    let swift_file = tmp_dir.join("ocr_tool.swift");
    let bin_file = tmp_dir.join("ocr_tool");

    std::fs::write(&swift_file, SWIFT_OCR)
        .map_err(|e| format!("写入Swift源码失败: {}", e))?;

    let need_compile = !bin_file.exists()
        || std::fs::metadata(&swift_file)
            .and_then(|s| s.modified())
            .ok()
            > std::fs::metadata(&bin_file)
            .and_then(|s| s.modified())
            .ok();

    if need_compile {
        eprintln!("[ocr] Compiling Swift Vision OCR helper...");
        let compile = Command::new("swiftc")
            .arg(&swift_file)
            .arg("-framework").arg("Vision")
            .arg("-framework").arg("Foundation")
            .arg("-o").arg(&bin_file)
            .output()
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    "swiftc未安装，Apple Vision OCR不可用".into()
                } else {
                    format!("编译OCR助手失败: {}", e)
                }
            })?;

        if !compile.status.success() {
            let stderr = String::from_utf8_lossy(&compile.stderr);
            return Err(format!("编译OCR助手失败: {}", stderr.trim()));
        }
        eprintln!("[ocr] Swift Vision OCR helper compiled");
    }

    Ok(bin_file)
}

#[tauri::command]
pub fn extract_text(image_path: String) -> Result<String, String> {
    if !std::path::Path::new(&image_path).exists() {
        return Err(format!("文件不存在: {}", image_path));
    }

    if let Ok(metadata) = std::fs::metadata(&image_path) {
        const MAX_SIZE: u64 = 100 * 1024 * 1024;
        if metadata.len() > MAX_SIZE {
            return Err(format!(
                "文件过大 ({}MB)，最大支持100MB。建议只读取前N页/行。",
                metadata.len() / (1024 * 1024)
            ));
        }
    }

    let bin_file = match ensure_ocr_tool() {
        Ok(b) => b,
        Err(e) => {
            if e.contains("swiftc未安装") {
                return Err("图片识别失败，Apple Vision不可用。swiftc未安装，请安装Xcode命令行工具。".into());
            }
            return Err(format!("图片识别失败，请提供文字描述。{}", e));
        }
    };

    let output = Command::new(&bin_file)
        .arg(&image_path)
        .output()
        .map_err(|e| format!("图片识别失败，请提供文字描述。OCR执行失败: {}", e))?;

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if stderr.contains("ERROR:NO_PATH") {
        return Err("图片识别失败，图片路径无效。".into());
    }
    if stderr.contains("ERROR:LOAD_IMAGE") {
        return Err("图片识别失败，无法加载图片。请确认图片格式正确。".into());
    }
    if stderr.contains("ERROR:VISION_PERFORM") {
        return Err("图片识别失败，Vision框架执行出错。请提供文字描述。".into());
    }
    if stderr.contains("ERROR:") {
        return Err("图片识别失败，请提供文字描述。".into());
    }

    if !output.status.success() {
        return Err(format!("图片识别失败，请提供文字描述。错误: {}", stderr.trim()));
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();

    if text.is_empty() {
        return Err("图片识别失败，未提取到文字。请提供文字描述。".into());
    }

    Ok(text)
}

#[tauri::command]
pub fn process_image(image_path: String) -> Result<ImageProcessResult, String> {
    let path = std::path::Path::new(&image_path);

    if !path.exists() {
        return Err(format!("文件不存在: {}", image_path));
    }

    let metadata = std::fs::metadata(&image_path)
        .map_err(|e| format!("无法读取文件信息: {}", e))?;
    let file_size = metadata.len();

    const MAX_SIZE: u64 = 100 * 1024 * 1024;
    if file_size > MAX_SIZE {
        return Err(format!(
            "文件过大 ({}MB)，最大支持100MB。建议压缩后上传。",
            file_size / (1024 * 1024)
        ));
    }

    let file_name = path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".into());

    let ocr_result = extract_text(image_path.clone());

    match ocr_result {
        Ok(text) => {
            if text.is_empty() {
                Ok(ImageProcessResult {
                    path: image_path.clone(),
                    name: file_name,
                    ocr_text: None,
                    ocr_status: "no_text".into(),
                    file_size,
                })
            } else {
                Ok(ImageProcessResult {
                    path: image_path.clone(),
                    name: file_name,
                    ocr_text: Some(text),
                    ocr_status: "success".into(),
                    file_size,
                })
            }
        }
        Err(e) => {
            let status = if e.contains("swiftc未安装") || e.contains("Vision不可用") {
                "not_available"
            } else {
                "failed"
            };
            Ok(ImageProcessResult {
                path: image_path.clone(),
                name: file_name,
                ocr_text: None,
                ocr_status: status.into(),
                file_size,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_text_file_not_found() {
        let result = extract_text("/nonexistent/image.png".into());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("文件不存在"));
    }
}
