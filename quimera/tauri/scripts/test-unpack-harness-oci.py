import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('unpack_oci', Path(__file__).with_name('unpack-harness-oci.py'))
subject = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subject)


class EnvelopeTests(unittest.TestCase):
    def archive(self, root, entries):
        source = root / 'fixture.tar'
        with tarfile.open(source, 'w') as archive:
            for name, payload, kind in entries:
                entry = tarfile.TarInfo(name)
                entry.size, entry.type = len(payload), kind
                if kind == tarfile.SYMTYPE:
                    entry.linkname = '../outside'
                archive.addfile(entry, io.BytesIO(payload))
        return source

    def test_envelope_only_no_layer_extraction(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            entries = [('oci-layout', b'{}', tarfile.REGTYPE), ('index.json', b'{}', tarfile.REGTYPE),
                       ('blobs/sha256/' + 'a' * 64, b'not-extracted-layer', tarfile.REGTYPE)]
            source = self.archive(root, entries)
            result = subject.unpack(source, root / 'layout')
            self.assertEqual(result['files'], 3)
            self.assertFalse(result['layerFilesystemsExtracted'])
            self.assertEqual((root / 'layout/blobs/sha256' / ('a' * 64)).read_bytes(), b'not-extracted-layer')

    def test_rejects_traversal_links_duplicates_and_existing_destination(self):
        attacks = [[('../outside', b'x', tarfile.REGTYPE)],
                   [('index.json', b'', tarfile.SYMTYPE)],
                   [('index.json', b'{}', tarfile.REGTYPE)] * 2]
        for entries in attacks:
            with self.subTest(entries=entries), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary).resolve()
                source = self.archive(root, entries)
                with self.assertRaises(ValueError):
                    subject.unpack(source, root / 'layout')
                self.assertFalse((root / 'outside').exists())
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            source = self.archive(root, [('index.json', b'{}', tarfile.REGTYPE)])
            (root / 'existing').mkdir()
            with self.assertRaises(ValueError):
                subject.unpack(source, root / 'existing')


if __name__ == '__main__':
    unittest.main()
