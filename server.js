import express from "express";
import cors from "cors";
import fileUpload from "express-fileupload";
import dotenv from "dotenv";
import { Dropbox } from "dropbox";
import fetch from "node-fetch";
import PDFDocument from "pdfkit";
import { Resend } from "resend";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));
app.use(fileUpload());
app.use(express.static("."));

const PORT = process.env.PORT || 3000;

const dbx = new Dropbox({
  accessToken: process.env.DROPBOX_ACCESS_TOKEN,
  fetch
});

const resend = new Resend(process.env.RESEND_API_KEY);

const PROPERTIES_PATH = "/System/properties.json";
const APPLICATIONS_PATH = "/System/applications.json";

function cleanName(value) {
  return String(value || "Unknown")
    .replace(/[^a-zA-Z0-9 _.-]/g, "")
    .trim();
}

function makeCode() {
  return "OV-" + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function checkAdminPassword(req, res, next) {
  const password = req.headers["x-admin-password"];

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      error: "Wrong admin password"
    });
  }

  next();
}

async function readDropboxJson(path) {
  try {
    const result = await dbx.filesDownload({ path });
    const buffer = result.result.fileBinary;
    return JSON.parse(buffer.toString());
  } catch (error) {
    if (error?.status === 409) {
      await writeDropboxJson(path, []);
      return [];
    }

    throw error;
  }
}

async function writeDropboxJson(path, data) {
  await dbx.filesUpload({
    path,
    contents: Buffer.from(JSON.stringify(data, null, 2)),
    mode: { ".tag": "overwrite" },
    autorename: false
  });
}

async function createApplicationPDF(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40 });
    const chunks = [];

    doc.on("data", chunk => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(20).text("Rental Application", { align: "center" });
    doc.moveDown();

    doc.fontSize(14).text("Application Details", { underline: true });
    doc.moveDown(0.5);

    for (const key in data) {
      if (key === "Applicant Signature") continue;
      if (!data[key]) continue;

      doc.fontSize(10).text(`${key}: `, { continued: true });
      doc.fontSize(10).text(`${data[key]}`);
      doc.moveDown(0.25);
    }

    if (data["Applicant Signature"]) {
      try {
        doc.addPage();
        doc.fontSize(14).text("Applicant Signature", { underline: true });
        doc.moveDown();

        const base64 = data["Applicant Signature"].replace(/^data:image\/png;base64,/, "");
        const imgBuffer = Buffer.from(base64, "base64");

        doc.image(imgBuffer, {
          fit: [450, 180],
          align: "left"
        });
      } catch (e) {
        doc.text("Signature could not be added to PDF.");
      }
    }

    doc.end();
  });
}

app.get("/api/properties", checkAdminPassword, async (req, res) => {
  const properties = await readDropboxJson(PROPERTIES_PATH);

  res.json({
    success: true,
    properties
  });
});

app.post("/api/properties", checkAdminPassword, async (req, res) => {
  const properties = await readDropboxJson(PROPERTIES_PATH);

  const newProperty = {
    id: Date.now().toString(),
    propertyName: req.body.propertyName || "",
    address: req.body.address || "",
    defaultRent: req.body.defaultRent || "",
    defaultDeposit: req.body.defaultDeposit || "",
    defaultAvailableDate: req.body.defaultAvailableDate || "",
    defaultPetsAllowed: req.body.defaultPetsAllowed || "No",
    defaultPetDeposit: req.body.defaultPetDeposit || "",
    notes: req.body.notes || "",
    createdAt: new Date().toISOString()
  };

  properties.push(newProperty);

  await writeDropboxJson(PROPERTIES_PATH, properties);

  res.json({
    success: true,
    property: newProperty
  });
});

app.put("/api/properties/:id", checkAdminPassword, async (req, res) => {
  const properties = await readDropboxJson(PROPERTIES_PATH);

  const index = properties.findIndex(p => p.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({
      success: false,
      error: "Property not found"
    });
  }

  properties[index] = {
    ...properties[index],
    propertyName: req.body.propertyName || "",
    address: req.body.address || "",
    defaultRent: req.body.defaultRent || "",
    defaultDeposit: req.body.defaultDeposit || "",
    defaultAvailableDate: req.body.defaultAvailableDate || "",
    defaultPetsAllowed: req.body.defaultPetsAllowed || "No",
    defaultPetDeposit: req.body.defaultPetDeposit || "",
    notes: req.body.notes || "",
    updatedAt: new Date().toISOString()
  };

  await writeDropboxJson(PROPERTIES_PATH, properties);

  res.json({
    success: true,
    property: properties[index]
  });
});

app.delete("/api/properties/:id", checkAdminPassword, async (req, res) => {
  let properties = await readDropboxJson(PROPERTIES_PATH);

  properties = properties.filter(p => p.id !== req.params.id);

  await writeDropboxJson(PROPERTIES_PATH, properties);

  res.json({
    success: true
  });
});

app.post("/api/application-links", checkAdminPassword, async (req, res) => {
  const applications = await readDropboxJson(APPLICATIONS_PATH);

  const code = makeCode();

  const newApplication = {
    code,
    propertyId: req.body.propertyId || "",
    propertyName: req.body.propertyName || "",
    address: req.body.address || "",
    tenantEmail: req.body.tenantEmail || "",
    rent: req.body.rent || "",
    availableDate: req.body.availableDate || "",
    deposit: req.body.deposit || "",
    petsAllowed: req.body.petsAllowed || "No",
    petDeposit: req.body.petDeposit || "",
    notes: req.body.notes || "",
    status: "Open",
    createdAt: new Date().toISOString()
  };

  applications.push(newApplication);

  await writeDropboxJson(APPLICATIONS_PATH, applications);

  const link = `https://oceanvacationsmb.github.io/rentapp/apply.html?code=${code}`;

  let petText = "";

  if (newApplication.petsAllowed !== "No") {
    petText =
`Pets:
${newApplication.petsAllowed}

Pet Deposit / Pet Rent:
${newApplication.petDeposit || "N/A"}

`;
  }

  let emailSent = false;
  let emailError = "";

  if (newApplication.tenantEmail) {
    try {
      const result = await resend.emails.send({
        from: process.env.FROM_EMAIL || "onboarding@resend.dev",
        to: newApplication.tenantEmail,
        subject: "Rental Application",
        text:
`Hi,

Please complete the rental application using this link:

${link}

Property:
${newApplication.propertyName}

Address:
${newApplication.address}

Rent:
$${newApplication.rent}

Available Date:
${newApplication.availableDate || "N/A"}

Security Deposit:
$${newApplication.deposit}

${petText}Thank you`
      });

      console.log("EMAIL SENT:", result);
      emailSent = true;

    } catch (error) {
      console.log("EMAIL ERROR:", error);
      emailError = error.message || JSON.stringify(error);
    }
  }

  res.json({
    success: true,
    application: newApplication,
    emailSent,
    emailError
  });
});

app.get("/api/application/:code", async (req, res) => {
  const applications = await readDropboxJson(APPLICATIONS_PATH);

  const application = applications.find(
    app => app.code === req.params.code && app.status === "Open"
  );

  if (!application) {
    return res.status(404).json({
      success: false,
      error: "Application link not found or closed"
    });
  }

  res.json({
    success: true,
    application
  });
});

app.post("/submit-application", async (req, res) => {
  try {
    const code = req.body.applicationCode || "";
    const applications = await readDropboxJson(APPLICATIONS_PATH);

    const savedApplication = applications.find(app => app.code === code);

    const applicantName = cleanName(
      `${req.body["Applicant 1 First Name"] || ""} ${req.body["Applicant 1 Last Name"] || ""}`
    );

    const property = cleanName(
      req.body.property ||
      req.body.propertyName ||
      savedApplication?.propertyName ||
      "Unknown Property"
    );

    const folderName =
      `/Rental Applications/${property}/${code || Date.now()}-${applicantName || "Unknown Applicant"}`;

    await dbx.filesCreateFolderV2({
      path: folderName,
      autorename: true
    });

    const pdfBuffer = await createApplicationPDF(req.body);

    await dbx.filesUpload({
      path: `${folderName}/rental-application.pdf`,
      contents: pdfBuffer,
      mode: { ".tag": "overwrite" },
      autorename: false
    });

    if (req.files) {
      for (const key in req.files) {
        const file = req.files[key];

        if (Array.isArray(file)) {
          for (const item of file) {
            const safeName = item.name.replace(/[^a-zA-Z0-9._-]/g, "_");

            await dbx.filesUpload({
              path: `${folderName}/${safeName}`,
              contents: item.data,
              autorename: true
            });
          }
        } else {
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");

          await dbx.filesUpload({
            path: `${folderName}/${safeName}`,
            contents: file.data,
            autorename: true
          });
        }
      }
    }

    if (savedApplication) {
      savedApplication.status = "Submitted";
      savedApplication.submittedAt = new Date().toISOString();
      savedApplication.dropboxFolder = folderName;

      await writeDropboxJson(APPLICATIONS_PATH, applications);
    }

    res.json({
      success: true,
      dropboxFolder: folderName
    });

  } catch (error) {
    console.log(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
