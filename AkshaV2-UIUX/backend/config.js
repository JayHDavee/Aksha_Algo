import dotenv from "dotenv";
const debug = require("debug")("author");
debug(process.env.NODE_ENV)
dotenv.config({ path: `${process.cwd()}/.env.${process.env.NODE_ENV}` });
