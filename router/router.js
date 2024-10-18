const express = require('express');
const db = require('../db'); // MySQL connection
const bitcore = require('bitcore-lib'); // Import bitcore-lib
const crypto = require('crypto'); // Node.js crypto module for random key generation
const router = express.Router();
const axios = require('axios');

// Signup route to create a user and generate a Bitcoin wallet
router.post('/signup', async (req, res) => {
  const { username, email } = req.body;

  try {
    // Validate input
    if (!username || !email) {
      return res.status(400).json({ message: 'Username and email are required' });
    }

    // Check if user already exists
    const [existingUser] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (existingUser.length > 0) {
      return res.status(400).json({ message: 'User already exists' });
    }

    // Generate Bitcoin wallet
    const keyPair = new bitcore.PrivateKey(bitcore.Networks.testnet); // Create a new private key
    const address = keyPair.toAddress().toString(); // Get the corresponding address
    const privateKey = keyPair.toWIF(); // Get the private key in Wallet Import Format

    // Insert new user into the database
    const [result] = await db.query(
      'INSERT INTO users (username, email, address, privateKey) VALUES (?, ?, ?, ?)', 
      [username, email, address, privateKey]
    );

    // Respond with success message and Bitcoin address
    res.status(201).json({
      message: 'User registered successfully',
      data: {
        userId: result.insertId,
        username,
        email,
        address,
      }
    });

  } catch (error) {
    console.error('Error during user signup:', error);
    res.status(500).json({ message: 'An error occurred during signup', error: error.message });
  }
});




// const getBalance = async (address) => {
//     try {
//       const response = await axios.get(`${BLOCKCYPHER_API_URL}/addrs/${address}/balance?token=${BLOCKCYPHER_API_KEY}`);
//       console.log('API Response:', response.data);  // Log the API response
//       return response.data.balance;
//     } catch (error) {
//       console.error('API Error:', error.response ? error.response.data : error.message);  // Log detailed error
//       throw new Error('Error retrieving balance from BlockCypher');
//     }
//   };
  
// // Endpoint to get balance
// router.get('/balance/:address', async (req, res) => {
//   const { address } = req.params;

//   try {
//     // Retrieve balance from BlockCypher
//     const balance = await getBalance(address);
//     res.status(200).json({ address, balance });
//   } catch (error) {
//     res.status(500).json({ message: 'Error retrieving balance', error: error.message });
//   }
// });









// Function to update the balance in the database
const updateBalanceInDB = async (address, balance) => {
  try {
    const [result] = await db.query(`
      UPDATE users SET balance = ? WHERE address = ?
    `, [balance, address]);

        // Convert satoshis to BTC
        // const balanceInBTC = balanceInSatoshis / 100000000;

        // const [result] = await db.query(`
        //   INSERT INTO users (address, balance) 
        //   VALUES (?, ?)
        //   ON DUPLICATE KEY UPDATE balance = ?
        // `, [address, balanceInBTC, balanceInBTC]);
    

    console.log('Balance updated in DB:', result);
  } catch (error) {
    console.error('Error updating balance in DB:', error.message);
    throw new Error('Error updating balance in database');
  }
};

// Function to get balance from BlockCypher API and update it in the database
const getBalance = async (address) => {
  try {
    // Fetch balance from BlockCypher API
    const response = await axios.get(`${BLOCKCYPHER_API_URL}/addrs/${address}/balance?token=${BLOCKCYPHER_API_KEY}`);
    console.log('API Response:', response.data);  // Log the API response
    
    const balance = response.data.balance;
    
    // Update the balance in the database
    await updateBalanceInDB(address, balance);
    
    return balance;
  } catch (error) {
    console.error('API Error:', error.response ? error.response.data : error.message);  // Log detailed error
    throw new Error('Error retrieving balance from BlockCypher');
  }
};

// Express route to get and update balance
router.get('/balance/:address', async (req, res) => {
  const { address } = req.params;

  try {
    // Retrieve balance from BlockCypher and update in DB
    const balance = await getBalance(address);
    
    res.status(200).json({ address, balance });
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving balance', error: error.message });
  }
});


const sendBitcoin = async (fromAddress, toAddress, amount, privateKey) => {
  try {
    // Step 1: Fetch unspent transaction outputs (UTXOs)
    const utxoResponse = await axios.get(`${BLOCKCYPHER_API_URL}/addrs/${fromAddress}?unspentOnly=true&token=${BLOCKCYPHER_API_KEY}`);
    console.log('UTXO Response:', utxoResponse.data);  // Log UTXO response

    // Check both txrefs and unconfirmed_txrefs
    const txrefs = utxoResponse.data.txrefs || [];
    const unconfirmedTxrefs = utxoResponse.data.unconfirmed_txrefs || [];

    if (txrefs.length === 0 && unconfirmedTxrefs.length === 0) {
      console.error('No UTXOs found for the address:', fromAddress);
      throw new Error('No UTXOs found for the address');
    }

    // Combine confirmed and unconfirmed UTXOs
    const allTxrefs = [...txrefs, ...unconfirmedTxrefs];

    // Validate UTXO data
    if (!Array.isArray(allTxrefs)) {
      throw new Error('Invalid UTXO data format');
    }

    // Filter UTXOs to avoid dust outputs
    const minOutputValue = 546; // Dust threshold in satoshis
    const filteredUtxos = allTxrefs.filter(utxo => utxo.value >= minOutputValue);

    if (filteredUtxos.length === 0) {
      throw new Error('No valid UTXOs found that meet the minimum value requirement');
    }

    // Check if the total amount to send is less than the sum of available UTXOs
    const totalAvailable = filteredUtxos.reduce((acc, utxo) => acc + utxo.value, 0);
    if (amount > totalAvailable) {
      throw new Error('Insufficient funds to cover the transaction amount');
    }

    // Prepare UTXOs for transaction
    const utxos = filteredUtxos.map(utxo => ({
      txId: utxo.tx_hash,
      outputIndex: utxo.tx_output_n,
      address: fromAddress,
      script: bitcore.Script.buildPublicKeyHashOut(bitcore.Address.fromString(fromAddress)).toString(),
      satoshis: utxo.value,
    }));

    // Log UTXO mapping
    console.log('Mapped UTXOs:', utxos);

    // Step 2: Create a transaction
    const transaction = new bitcore.Transaction()
      .from(utxos) // Use UTXOs as inputs
      .to(toAddress, amount) // Specify the recipient and amount in satoshis
      .change(fromAddress) // Send change back to the sender
      .sign(privateKey); // Sign the transaction with the private key

    // Log serialized transaction
    const serializedTx = transaction.serialize();
    console.log('Serialized Transaction:', serializedTx);

    // Step 3: Broadcast the transaction using BlockCypher
    const sendTxResponse = await axios.post(`${BLOCKCYPHER_API_URL}/txs/push?token=${BLOCKCYPHER_API_KEY}`, {
      tx: serializedTx,
    });

    console.log('Transaction Broadcast Response:', sendTxResponse.data);  // Log response from broadcasting

    return sendTxResponse.data.tx.hash; // Return the transaction ID
  } catch (error) {
    // Log the full error response for better debugging
    console.error('Error in sendBitcoin:', error.response ? error.response.data : error.message, error.stack);
    const errorMsg = error.response && error.response.data ? error.response.data.error : error.message;
    throw new Error(`Failed to send Bitcoin transaction: ${errorMsg}`);
  }
};

// Endpoint to send Bitcoin
router.post('/send', async (req, res) => {
  const { fromAddress, toAddress, amount, privateKey } = req.body;

  try {
      // Validate input
      if (!fromAddress || !toAddress || !amount || !privateKey) {
          return res.status(400).json({ message: 'All fields (fromAddress, toAddress, amount, privateKey) are required' });
      }

      // Convert amount from Bitcoin to satoshis (if necessary)
      const amountInSatoshis = amount * 1e8; // 1 Bitcoin = 100,000,000 satoshis

      // Send Bitcoin and get the transaction ID
      const txId = await sendBitcoin(fromAddress, toAddress, amountInSatoshis, privateKey);
      res.status(200).json({ message: 'Transaction sent', txId });
  } catch (error) {
      console.error('Error in /send endpoint:', error.message);
      res.status(500).json({ message: 'Error sending transaction', error: error.message });
  }
});


module.exports = router;
