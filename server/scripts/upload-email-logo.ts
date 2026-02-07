import { Storage } from '@google-cloud/storage';
import * as path from 'path';

async function uploadLogo() {
  const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!bucketId) {
    console.error('No bucket ID found');
    process.exit(1);
  }
  
  const storage = new Storage();
  const bucket = storage.bucket(bucketId);
  
  const logoPath = path.join(process.cwd(), 'public/images/everclub-logo-dark.png');
  const objectName = 'email-assets/everclub-logo-dark.png';
  
  console.log(`Uploading ${logoPath} to ${bucketId}/${objectName}...`);
  
  await bucket.upload(logoPath, {
    destination: objectName,
    metadata: {
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000',
    },
  });
  
  const file = bucket.file(objectName);
  await file.makePublic();
  
  const publicUrl = `https://storage.googleapis.com/${bucketId}/${objectName}`;
  console.log(`\nLogo uploaded successfully!`);
  console.log(`Public URL: ${publicUrl}`);
}

uploadLogo().catch(err => {
  console.error('Upload failed:', err.message);
  process.exit(1);
});
