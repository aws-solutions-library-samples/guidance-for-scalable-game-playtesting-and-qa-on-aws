const fs = require('fs');
const path = require('path');

try {
    if (fs.existsSync(path.join(__dirname, '../.deployment-failed'))) {
        console.error('Deployment failed at user creation step');
        process.exit(1);
    }
    process.exit(0);
} catch (err) {
    console.error('Error checking deployment status:', err);
    process.exit(1);
}
