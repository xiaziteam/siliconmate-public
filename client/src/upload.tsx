/**
 * 硅侣2.0 — 文件上传UI
 *
 * 功能：
 * - 回形针按钮触发文件选择
 * - 拖拽上传
 * - 支持图片/Office/其他文件
 * - 超大文件提示(>100MB)
 * - 文件类型识别
 */

import React, { useRef, useState } from 'react'

interface UploadProps {
  onFilesSelected: (files: File[]) => void
  maxFileSizeMB?: number
}

const MAX_FILE_SIZE_MB = 100

export const Upload: React.FC<UploadProps> = ({
  onFilesSelected,
  maxFileSizeMB = MAX_FILE_SIZE_MB,
}) => {
  const [dragOver, setDragOver] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const classifyFile = (file: File): string => {
    const ext = file.name.split('.').pop()?.toLowerCase() || ''
    const mime = file.type

    // Office files
    if (['docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt'].includes(ext)) return 'office'
    // Image files
    if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'].includes(ext)) return 'image'
    // PDF
    if (ext === 'pdf') return 'pdf'
    // Text files
    if (['txt', 'csv', 'json', 'xml', 'md', 'log', 'yaml', 'yml'].includes(ext) || mime.startsWith('text/')) return 'text'
    // Other
    return 'other'
  }

  const processFiles = (files: FileList | File[]) => {
    const newWarnings: string[] = []
    const processedFiles: File[] = []

    for (const file of Array.from(files)) {
      const sizeMB = file.size / (1024 * 1024)
      const fileType = classifyFile(file)

      if (sizeMB > maxFileSizeMB) {
        const fileType = classifyFile(file)
        let hint = ''
        if (fileType === 'pdf') {
          hint = `，只读取前${Math.floor(maxFileSizeMB * 10)}页`
        } else if (fileType === 'office') {
          hint = `，只读取前${Math.floor(maxFileSizeMB * 5)}页/行`
        } else if (fileType === 'text') {
          hint = `，只读取前${Math.floor(maxFileSizeMB * 1000)}行`
        } else {
          hint = '，只读取前N页/行'
        }
        newWarnings.push(`⚠️ ${file.name} (${sizeMB.toFixed(1)}MB) 文件过大，超过${maxFileSizeMB}MB限制${hint}`)
        // Still add the file but warn
      }

      processedFiles.push(file)
    }

    setWarnings(newWarnings)
    if (processedFiles.length > 0) {
      onFilesSelected(processedFiles)
    }
  }

  const handleClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      processFiles(e.target.files)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    processFiles(e.dataTransfer.files)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }

  const handleDragLeave = () => {
    setDragOver(false)
  }

  return (
    <>
      <button
        onClick={handleClick}
        title="上传文件（图片/Office/其他）"
        style={{
          background: dragOver ? '#3a3a4a' : '#2a2a3a',
          color: '#fff',
          border: dragOver ? '1px dashed #7a8aa0' : 'none',
          borderRadius: '10px',
          padding: '0 16px',
          cursor: 'pointer',
          fontSize: '16px',
          transition: 'background 0.2s',
        }}
      >
        📎
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.docx,.xlsx,.pptx,.doc,.xls,.ppt,.pdf,.txt,.csv,.json"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {/* Drop zone overlay */}
      {dragOver && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: 'rgba(42, 92, 255, 0.1)',
            border: '2px dashed #2a5cff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            color: '#2a5cff',
            fontSize: '18px',
            fontWeight: 600,
          }}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          拖拽文件到此处上传
        </div>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <div style={{
          position: 'fixed',
          bottom: '80px',
          left: '50%',
          transform: 'translateX(-50%)',
          background: '#1c2030',
          border: '1px solid #f39c12',
          borderRadius: '8px',
          padding: '8px 16px',
          color: '#f39c12',
          fontSize: '13px',
          zIndex: 999,
        }}>
          {warnings.map((w, i) => <div key={i}>{w}</div>)}
        </div>
      )}
    </>
  )
}
