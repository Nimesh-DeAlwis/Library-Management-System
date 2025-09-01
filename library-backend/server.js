// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sql = require('mssql');

const app = express();
app.use(cors());
app.use(express.json());

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER, // e.g. 'localhost' or 'localhost\\SQLEXPRESS'
  database: process.env.DB_NAME || 'LibraryDB',
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
  options: {
    encrypt: false,
    trustServerCertificate: true // for local dev with self-signed cert
  }
};

let poolPromise = null;
async function getPool() {
  if (!poolPromise) poolPromise = sql.connect(dbConfig);
  return poolPromise;
}

/* -- BOOKS API -- */
app.get('/api/books', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query('SELECT * FROM Books ORDER BY Title');
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/books', async (req, res) => {
  try {
    const { isbn, title, author, publisher, year, totalCopies } = req.body;
    const pool = await getPool();
    const result = await pool.request()
      .input('isbn', sql.VarChar(50), isbn)
      .input('title', sql.NVarChar(255), title)
      .input('author', sql.NVarChar(255), author)
      .input('publisher', sql.NVarChar(255), publisher)
      .input('year', sql.Int, year)
      .input('total', sql.Int, totalCopies || 1)
      .input('available', sql.Int, totalCopies || 1)
      .query(`INSERT INTO Books (ISBN,Title,Author,Publisher,YearPublished,TotalCopies,AvailableCopies)
              OUTPUT inserted.BookId
              VALUES (@isbn,@title,@author,@publisher,@year,@total,@available)`);
    res.json({ bookId: result.recordset[0].BookId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -- MEMBERS API -- */
app.get('/api/members', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query('SELECT * FROM Members ORDER BY FullName');
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/members', async (req, res) => {
  try {
    const { memberCode, fullName, email, phone, address } = req.body;
    const pool = await getPool();
    const result = await pool.request()
      .input('code', sql.VarChar(50), memberCode)
      .input('name', sql.NVarChar(255), fullName)
      .input('email', sql.VarChar(255), email)
      .input('phone', sql.VarChar(50), phone)
      .input('address', sql.NVarChar(500), address)
      .query(`INSERT INTO Members (MemberCode,FullName,Email,Phone,Address)
              OUTPUT inserted.MemberId
              VALUES (@code,@name,@email,@phone,@address)`);
    res.json({ memberId: result.recordset[0].MemberId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* -- BORROW (transaction) -- */
app.post('/api/borrow', async (req, res) => {
  const { bookId, memberId, days } = req.body;
  if (!bookId || !memberId) return res.status(400).json({ error: 'bookId and memberId required' });
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();
    const request = new sql.Request(transaction);

    const bookCheck = await request.input('bookId', sql.Int, bookId)
      .query('SELECT AvailableCopies FROM Books WHERE BookId = @bookId');

    if (bookCheck.recordset.length === 0) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Book not found' });
    }
    if (bookCheck.recordset[0].AvailableCopies <= 0) {
      await transaction.rollback();
      return res.status(400).json({ error: 'No copies available' });
    }

    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + (days || 14));

    await request.input('bookId', sql.Int, bookId)
      .input('memberId', sql.Int, memberId)
      .input('dueDate', sql.DateTime, dueDate)
      .query('INSERT INTO Loans (BookId,MemberId,DueDate) VALUES (@bookId,@memberId,@dueDate)');

    await request.input('bookId', sql.Int, bookId)
      .query('UPDATE Books SET AvailableCopies = AvailableCopies - 1 WHERE BookId = @bookId');

    await transaction.commit();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    await transaction.rollback().catch(()=>{});
    res.status(500).json({ error: err.message });
  }
});

/* -- RETURN (transaction) -- */
app.post('/api/return', async (req, res) => {
  const { loanId } = req.body;
  if (!loanId) return res.status(400).json({ error: 'loanId required' });
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();
    const request = new sql.Request(transaction);

    const loan = await request.input('loanId', sql.Int, loanId)
      .query('SELECT BookId, IsReturned FROM Loans WHERE LoanId = @loanId');

    if (loan.recordset.length === 0) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Loan not found' });
    }
    if (loan.recordset[0].IsReturned) {
      await transaction.rollback();
      return res.status(400).json({ error: 'Already returned' });
    }
    const bookId = loan.recordset[0].BookId;

    await request.input('loanId', sql.Int, loanId)
      .input('returnDate', sql.DateTime, new Date())
      .query('UPDATE Loans SET ReturnDate = @returnDate, IsReturned = 1 WHERE LoanId = @loanId');

    await request.input('bookId', sql.Int, bookId)
      .query('UPDATE Books SET AvailableCopies = AvailableCopies + 1 WHERE BookId = @bookId');

    await transaction.commit();
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    await transaction.rollback().catch(()=>{});
    res.status(500).json({ error: err.message });
  }
});

/* -- other helpful endpoints -- */
app.get('/api/loans', async (req, res) => {
  try {
    const pool = await getPool();
    const q = `
      SELECT l.LoanId, l.BookId, b.Title, l.MemberId, m.FullName, l.BorrowDate, l.DueDate, l.ReturnDate, l.IsReturned
      FROM Loans l
      INNER JOIN Books b ON b.BookId = l.BookId
      INNER JOIN Members m ON m.MemberId = l.MemberId
      ORDER BY l.BorrowDate DESC`;
    const result = await pool.request().query(q);
    res.json(result.recordset);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, ()=> console.log(`API listening ${PORT}`));
