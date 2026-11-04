import os,tempfile,unittest
from pathlib import Path
from app.control import inventory
class InventoryTests(unittest.TestCase):
 def test_dependencies_and_linked_directories_do_not_enter_project_inventory(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp)/'project';(root/'app').mkdir(parents=True);(root/'app/package.json').write_text('{}')
   (root/'node_modules/vendor').mkdir(parents=True);(root/'node_modules/vendor/package.json').write_text('{}')
   outside=Path(tmp)/'outside';outside.mkdir();(outside/'requirements.txt').write_text('private dependency')
   try:os.symlink(outside,root/'linked-external',target_is_directory=True);os.symlink(root,root/'cycle',target_is_directory=True)
   except OSError:pass
   result=inventory(root);self.assertEqual(result['count'],1);self.assertEqual(result['service_manifests'][0]['path'],'app')
