// This file to be removed for non-coursework use cases
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function generateCourseInitId() {
  const courseInitIdFilePath = path.join(__dirname, "course_init_id.js");

  if (fs.existsSync(courseInitIdFilePath)) {
    console.log("✓ Course ID file already exists. Skipping creation.");
    return;
  }

  const courseInitId =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : crypto.randomBytes(16).toString("hex");

  const fileContent = `// This file to be removed for non-coursework use cases
export const courseInitId = '${courseInitId}';
`;

  try {
    fs.writeFileSync(courseInitIdFilePath, fileContent, { mode: 0o444 });
    console.log(`✓ Course ID file created: ${courseInitId}`);
    fs.chmodSync(courseInitIdFilePath, 0o444);
  } catch (error) {
    console.error("Error creating course ID file:", error.message);
  }
}

generateCourseInitId();
