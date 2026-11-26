"""Authoring utility: fetch attributed Commons media; never runs in the app."""
import argparse
import hashlib
import html
import io
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
FILES = {
    'v01': 'Jacques-Louis David - The Emperor Napoleon in His Study at the Tuileries - Google Art Project.jpg',
    'v03': 'The Blue Marble.jpg',
    'v05': 'Vasil Levski-06.1A 1870 V1.jpg',
    'v07': 'Albert Einstein photo 1921.jpg',
    'v09': 'Baron Pierre de Coubertin.jpg',
    'v11': 'Charlie Chaplin portrait.jpg',
    'v13': 'Beethoven.jpg',
    'v15': 'BASA-1399K-1-1853-3-Ivan Vazov.JPG',
    'v17': 'Mona Lisa, by Leonardo da Vinci, from C2RMF retouched.jpg',
    'v19': 'Charles Babbage 1860.jpg',
    'v21': 'Panthera tigris tigris.jpg',
    'v23': 'Sushi platter.jpg',
    'v25': 'Sandro Botticelli - La nascita di Venere - Google Art Project - edited.jpg',
    'v27': 'Taj Mahal in March 2004.jpg',
    'v29': 'Rosetta Stone.JPG',
    'v31': 'Logo NIKE.svg',
    'v32': 'Mitsubishi logo.svg',
}


def fetch(url):
    with urlopen(Request(url, headers={'User-Agent': 'QuizTrainer/1.0 (offline educational question bank)'}), timeout=30) as response:
        return response.read()


def plain(value):
    return ' '.join(html.unescape(re.sub('<[^>]+>', ' ', value)).split())


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser()
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--refresh', nargs='*', default=[])
    args = parser.parse_args()
    params = {'action': 'query', 'format': 'json', 'redirects': 1, 'prop': 'imageinfo',
              'iiprop': 'url|extmetadata', 'iiurlwidth': 500,
              'titles': '|'.join('File:' + title for title in FILES.values())}
    data = json.loads(fetch('https://commons.wikimedia.org/w/api.php?' + urlencode(params)))['query']
    redirects = {r['from']: r['to'] for r in data.get('redirects', [])}
    normalized = {r['from']: r['to'] for r in data.get('normalized', [])}
    pages = {page['title']: page for page in data['pages'].values()}
    manifest_path = ROOT / 'static/media/credits.json'
    manifest = json.loads(manifest_path.read_text('utf-8')) if manifest_path.exists() else {}
    for key, title in FILES.items():
        title = normalized.get('File:' + title, 'File:' + title)
        title = redirects.get(title, title)
        info = pages.get(title, {}).get('imageinfo')
        if not info:
            print('MISSING', key, title, flush=True)
            continue
        item = info[0]
        meta = item['extmetadata']
        license_name = plain(meta.get('LicenseShortName', {}).get('value', ''))
        author = plain(meta.get('Artist', {}).get('value', 'Unknown author'))
        print(key, title, '|', license_name, '|', author[:100], flush=True)
        if not args.download:
            continue
        if not (license_name.startswith(('CC BY', 'CC0', 'Public domain', 'PD'))):
            raise ValueError(f'License needs review: {title}: {license_name}')
        extension = '.jpg'
        path = ROOT / 'static/media' / (key + extension)
        if path.exists() and key in manifest and key not in args.refresh:
            continue
        try:
            raw = fetch(item.get('thumburl', item['url']).split('?')[0])
        except Exception as error:
            print('DOWNLOAD FAILED', key, str(error), flush=True)
            continue
        if extension == '.jpg':
            from PIL import Image
            rgba = Image.open(io.BytesIO(raw)).convert('RGBA')
            background = Image.new('RGBA', rgba.size, 'white')
            img = Image.alpha_composite(background, rgba).convert('RGB')
            img.thumbnail((960, 960))
            img.save(path, quality=88, optimize=True)
        else:
            root = ET.fromstring(raw)
            for parent in root.iter():
                for child in list(parent):
                    if child.tag.split('}')[-1] in ('metadata', 'title', 'desc'):
                        parent.remove(child)
            for node in root.iter():
                if node.tag.split('}')[-1] in ('script', 'foreignObject', 'image', 'a'):
                    raise ValueError('Unexpected active SVG content')
                for name, value in node.attrib.items():
                    if name.lower().startswith('on') or (name.endswith('href') and not value.startswith('#')):
                        raise ValueError('Unexpected SVG link')
            ET.register_namespace('', 'http://www.w3.org/2000/svg')
            path.write_bytes(ET.tostring(root, encoding='utf-8', xml_declaration=True))
        manifest[key] = {'path': '/media/' + path.name, 'credit': author,
                         'license': license_name, 'source_url': item['descriptionurl'],
                         'license_url': meta.get('LicenseUrl', {}).get('value', ''),
                         'original_title': title, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                         'changes': 'Resized and converted to JPEG; metadata removed' if extension == '.jpg' else 'Metadata removed'}
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
