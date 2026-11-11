#!/usr/bin/env python3
"""favops.py —— 「刷B站」的收藏边车（宿主直接调，不经过 MCP，模型拿不到这只手）

用法：
  python favops.py folders            # 列收藏夹 → 末行 JSON {"ok":true,"folders":[{id,title,count}]}
  python favops.py add <bvid> <fid>   # 收藏 → {"ok":true} / {"ok":false,"error":"..."}
"""
import asyncio
import json
import os
import re
import sys

# P3-31: Windows 管道默认 GBK —— 错误 JSON 里的中文/emoji 会把 print 打挂
#（UnicodeEncodeError 连 JSON 都出不来），先钉 UTF-8 + replace（写法照 lib/pv.py:41-46）
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# 凭证找两处：优先**当前工作目录**（宿主 spawn 时 cwd = 插件家，凭证就在那儿），
# 退回脚本旁边（脚本被铺到插件家后两者一致）
CRED_CANDIDATES = [
    os.path.join(os.getcwd(), 'bili_credential.json'),
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bili_credential.json'),
]
CRED_FILE = next((p for p in CRED_CANDIDATES if os.path.exists(p)), CRED_CANDIDATES[0])


def out(obj):
    # P3-31: stdout 已钉 utf-8 + errors="replace"，任何字符都出得去，不再 UnicodeEncodeError
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(0)


def _classify(error):
    """P3-32: 错误分类 —— code 取 bilibili_api 异常自带的 API code（ResponseCodeException.code），
    kind 让宿主分得清「要重扫码」（auth = -101/-111）、「等风控」（risk = 412/-352）、
    「已经收藏过」（dup，幂等成功）和其余失败（unknown）。"""
    code = getattr(error, 'code', None)
    try:
        code = int(code) if code is not None else None
    except (TypeError, ValueError):
        code = None
    msg = str(error)
    if code in (-101, -111):
        kind = 'auth'
    elif code in (412, -352):
        kind = 'risk'
    elif '已经' in msg or 'already' in msg.lower():
        kind = 'dup'
    else:
        kind = 'unknown'
    return code, kind, msg


def load():
    from bilibili_api import Credential
    if not os.path.exists(CRED_FILE):
        out({'ok': False, 'error': '还没扫码登录（bili_credential.json 不存在）'})
    with open(CRED_FILE, encoding='utf-8') as f:
        d = json.load(f)
    return Credential(
        sessdata=d['sessdata'],
        bili_jct=d['bili_jct'],
        buvid3=d.get('buvid3', ''),
        dedeuserid=str(d['dedeuserid']),
    ), int(d['dedeuserid'])


async def folders():
    from bilibili_api import favorite_list
    cred, uid = load()
    res = await favorite_list.get_video_favorite_list(uid, credential=cred)
    items = (res or {}).get('list') or []
    out({'ok': True, 'folders': [{'id': it.get('id'), 'title': it.get('title'), 'count': it.get('media_count', 0)} for it in items]})


async def add(bvid, fid):
    if not isinstance(bvid, str) or not re.fullmatch(r'BV[0-9A-Za-z]{10}', bvid):
        raise ValueError('视频 BV 号格式无效')
    if isinstance(fid, bool) or not isinstance(fid, int) or fid <= 0:
        raise ValueError('收藏夹 ID 必须为正整数')
    # 2026-10-26：删掉了原来那句 `FavoriteList(aid, credential=cred).get_info()` ——
    # 它把**视频 aid** 当收藏夹 media_id 传进去，查的是"编号恰好等于这个 aid 的收藏夹"，
    # 几乎必然不存在/报错；结果没被使用，却会把整个 add() 拖崩（真正的收藏动作到不了）。
    from bilibili_api import favorite_list
    from bilibili_api import video as ba_video
    cred, _ = load()
    info = await ba_video.Video(bvid=bvid, credential=cred).get_info()
    aid = int(info['aid'])
    try:
        await favorite_list.FavoriteListResource(aid, type_=2, credential=cred).add(fid)
    except Exception as error:  # noqa: BLE001
        code, kind, msg = _classify(error)
        # 已经收藏过不算失败：幂等判断保留子串兜底，但优先按 code 分好的类走
        if kind == 'dup':
            out({'ok': True, 'already': True, 'code': code, 'kind': kind})
        out({'ok': False, 'error': msg[:200], 'code': code, 'kind': kind})
    out({'ok': True})


def main():
    args = sys.argv[1:]
    if not args:
        out({'ok': False, 'error': '没有子命令（folders / add）'})
    try:
        if args[0] == 'folders' and len(args) == 1:
            asyncio.run(folders())
        elif args[0] == 'add' and len(args) == 3:
            if not re.fullmatch(r'[0-9]+', args[2]):
                raise ValueError('收藏夹 ID 必须为正整数')
            asyncio.run(add(args[1], int(args[2])))
        else:
            out({'ok': False, 'error': '子命令不认识：' + ' '.join(args)})
    except Exception as error:  # noqa: BLE001
        # P3-32: 兜底出口同样带 code/kind，宿主不用再猜错误文本
        code, kind, msg = _classify(error)
        out({'ok': False, 'error': msg[:300], 'code': code, 'kind': kind})


if __name__ == '__main__':
    main()
