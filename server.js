import express from "express";
import cors from "cors";
import fileUpload from "express-fileupload";
import dotenv from "dotenv";
import { Dropbox } from "dropbox";
import fetch from "node-fetch";

dotenv.config();

const app = express();

app.use(cors());

app.use(express.json());

app.use(express.urlencoded({ extended: true }));

app.use(fileUpload());

app.use(express.static("."));

const dbx = new Dropbox({
  accessToken: process.env.DROPBOX_ACCESS_TOKEN,
  fetch
});

app.post("/submit-application", async (req, res) => {

  try {

    const applicantName =
      req.body.applicantName || "Unknown Applicant";

    const property =
      req.body.property || "Unknown Property";

    const folderName =
      `/Rental Applications/${property}/${Date.now()}-${applicantName}`;

    await dbx.filesCreateFolderV2({
      path: folderName,
      autorename: true
    });

    const fieldsFile = Buffer.from(
      JSON.stringify(req.body, null, 2)
    );

    await dbx.filesUpload({
      path: `${folderName}/application.json`,
      contents: fieldsFile
    });

    if (req.files) {

      for (const key in req.files) {

        const file = req.files[key];

        const safeName =
          file.name.replace(/[^a-zA-Z0-9._-]/g, "_");

        await dbx.filesUpload({
          path: `${folderName}/${safeName}`,
          contents: file.data
        });
      }
    }

    res.json({
      success: true
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(3000, () => {

  console.log("Server running on port 3000");

});
