const express = require('express');
const cors = require('cors');
const db = require('./db'); // MySQL connection pool
const userRouter = require('./router/router');
// const adminRouter = require('./router/adminRouter');
require('dotenv').config();

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

app.use('/uploads', express.static('uploads'));
app.use('/api/user', userRouter); 
// app.use('/api/admin', adminRouter); 

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
