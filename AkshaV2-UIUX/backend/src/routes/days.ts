/**
 * Route to handle setting the workday data.
 * Expects a query parameter 'workday' and writes it to a global JSON file.
 */

import express, { Request, Response } from "express";
import fs from "fs";
const router = express.Router();

router.get(process.env.DAYS as string, (req: any, res: any) => {
  let workday = req.query;
  if (!req.query.workday) {
    return res.status(400).json({
      success: false,
      message: "please provide proper data",
    });
  }
  try {
    fs.writeFileSync(
     ` ${process.env.AKSHA_PATH}/global.json`,
      JSON.stringify(workday),
      "utf8"
    );

    res.status(200).json({
      success: true,
      message: "response has been submitted",
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
});

export default router;