import { transcribeImage } from '../read-image.mjs';

try {
  console.log(JSON.stringify(await transcribeImage(process.argv[2]), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
