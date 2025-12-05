const Review = require('../models/Review');

const list = (req, res) => {
  Review.listAll((err, reviews) => {
    if (err) {
      console.error('DB error loading reviews', err);
      return res.status(500).send('Error loading reviews');
    }
    res.render('adminReviews', { user: req.session.user, reviews });
  });
};

const reply = (req, res) => {
  const { id } = req.params;
  const replyText = req.body.reply || '';
  Review.reply(id, replyText, (err) => {
    if (err) {
      console.error('DB error replying to review', err);
      return res.status(500).send('Error saving reply');
    }
    res.redirect('/admin/reviews');
  });
};

const remove = (req, res) => {
  const { id } = req.params;
  Review.remove(id, (err) => {
    if (err) {
      console.error('DB error deleting review', err);
      return res.status(500).send('Error deleting review');
    }
    res.redirect('/admin/reviews');
  });
};

module.exports = { list, reply, remove };
