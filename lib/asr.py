#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
asr.py —— 把一条 B站 视频（或本地音视频文件）转成文字。
给"这个视频没有字幕、但又值得判断"的情况用。

用法（在插件的 ASR 环境里跑）：
    .venv-asr/Scripts/python.exe asr.py BV1xxxxxxxxx          # Windows
    .venv-asr/bin/python       asr.py https://www.bilibili.com/video/BV1xx
    .venv-asr/Scripts/python.exe asr.py D:\\some\\clip.mp4 -o out.txt
    …还可以加 --model small / --model medium 换模型（默认 small）

设计上的两个要点：
  ① **模型走国内镜像**（HF_ENDPOINT=hf-mirror.com）—— 否则 HuggingFace 拉不动
  ② **音频不落盘到别处**：yt-dlp 下到临时目录，转写完就随系统清理
"""
import argparse
import os
import re
import sys
import uuid

# ⚠️ 临时目录必须待在家目录里：值班那一轮跑在沙箱里（只允许写工作区/cwd），
#    yt-dlp 默认往 %TEMP% 写、会被直接拒掉（2026-10-14 在主人机器上实证：
#    yt_dlp DownloadError: unable to open for writing: [Errno 13] Permission denied）
_HOME = os.path.dirname(os.path.abspath(__file__))
_TMP = os.path.join(_HOME, 'tmp', 'asr')

def prepare_runtime() -> None:
    """仅在执行命令时初始化环境，导入模块不改变进程的缓存或临时目录。"""
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    # 必须在 import faster_whisper 前设置；保留用户明确指定的端点与缓存。
    os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
    os.environ.setdefault('HF_HOME', os.path.join(_HOME, '.hf-cache'))
    os.environ.setdefault('HF_HUB_DISABLE_XET', '1')


def cleanup_download(tmp: str, tag: str) -> None:
    """只回收本次下载的独占文件前缀，也处理失败时留下的分片。"""
    try:
        with os.scandir(tmp) as entries:
            for entry in entries:
                if not entry.name.startswith(tag + '.'):
                    continue
                try:
                    # 不递归进入目录；即使出现符号链接也只删除链接本身。
                    if entry.is_file(follow_symlinks=False) or entry.is_symlink():
                        os.remove(entry.path)
                except OSError:
                    pass
    except OSError:
        pass


def to_url(target: str) -> str:
    t = target.strip()
    if t.upper().startswith('BV') and len(t) <= 20:
        return 'https://www.bilibili.com/video/' + t
    return t


def fetch_audio(url: str, tmp: str, tag: str) -> str:
    """用 yt-dlp 把音频拉下来（B站 是 DASH 音视频分离，取 bestaudio 即可，不需要 ffmpeg 合并）"""
    from yt_dlp import YoutubeDL
    opts = {
        'format': 'bestaudio/best',
        'outtmpl': os.path.join(tmp, tag + '.%(ext)s'),   # 每次调用的独占标签，允许同视频并行下载。
        'paths': {'home': tmp, 'temp': tmp},   # 别让 yt-dlp 往 %TEMP% 写（沙箱会拒）
        'cachedir': False,                      # 顺手别去动用户目录里的缓存
        # ⭐ nopart：不写 .part 再改名，直接落最终文件。
        #    沙箱里"新建文件 + 改名"会被拒，而这条能绕开（2026-10-14 值班那一轮自己试出来的）
        'nopart': True,
      # [2026-10-20 · 参考社区 PR #23] 进度条默认打到 stdout ⇒ 调用方"stdout 非空=成功"恒真 ✗
      #   我们是读文件走的，把进度关掉，别污染输出
      'noprogress': True,
        'quiet': True,
        'no_warnings': True,
        'noplaylist': True,
        'http_headers': {
            'Referer': 'https://www.bilibili.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        },
    }
    with YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
        return ydl.prepare_filename(info)


def main() -> int:
    ap = argparse.ArgumentParser(description='把一条视频转成文字（默认中文）')
    ap.add_argument('target', help='BV 号 / B站链接 / 本地音视频文件')
    ap.add_argument('-o', '--out', help='写到这个文件（不给就打到标准输出）')
    ap.add_argument('--model', default=os.environ.get('BILI_DUTY_ASR_MODEL', 'small'),
                    help='Whisper 模型大小：tiny / base / small / medium（默认 small）')
    ap.add_argument('--lang', default='zh', help='语言（默认 zh；不给就自动判断请传 auto）')
    args = ap.parse_args()
    prepare_runtime()

    src = args.target
    # ⚠️ 不用 mkdtemp：沙箱只允许写"子进程启动前就存在"的目录，新建的会被拒 ✗
    #    这个目录由宿主（插件）预先建好；使用唯一前缀而不是新建子目录。
    tmp = _TMP
    # 同一个视频也可能同时转写；清理权只属于本次远程下载，不属于本地输入。
    tag = os.path.basename(src).rsplit('.', 1)[0] or 'clip'
    tag = re.sub(r'[^0-9A-Za-z_-]', '_', tag)[:40] or 'clip'
    tag += '-' + uuid.uuid4().hex
    downloaded = False
    try:
        # 已存在的本地文件优先，即使文件名恰好以 BV/http 开头。
        if not os.path.exists(src) and (src.lower().startswith('http') or src.upper().startswith('BV')):
            os.makedirs(tmp, exist_ok=True)
            downloaded = True
            print('[asr] 先下音频…', file=sys.stderr)
            src = fetch_audio(to_url(src), tmp, tag)
        if not os.path.exists(src):
            print('[asr] 找不到文件：' + src, file=sys.stderr)
            return 2

        from faster_whisper import WhisperModel
        print('[asr] 加载模型 %s（第一次会自动下模型，之后就是本地读）…' % args.model, file=sys.stderr)
        model = WhisperModel(args.model, device='cpu', compute_type='int8')
        print('[asr] 开始转写…', file=sys.stderr)
        segments, _info = model.transcribe(
            src,
            language=None if args.lang == 'auto' else args.lang,
            vad_filter=True,          # 掐掉静音段，省时间也少出错
        )
        text = ''.join(seg.text for seg in segments).strip()
    finally:
        if downloaded:
            cleanup_download(tmp, tag)

    if args.out:
        with open(args.out, 'w', encoding='utf-8') as f:
            f.write(text)
        print('[asr] 已写入：' + args.out, file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
