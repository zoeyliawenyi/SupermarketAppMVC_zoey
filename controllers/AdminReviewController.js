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

const update = (req, res) => {
  const { id } = req.params;
  const rating = Number(req.body.rating);
  const comment = req.body.comment || '';
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).send('Rating must be between 1 and 5');
  }
  Review.update(id, { rating, comment }, (err) => {
    if (err) {
      console.error('DB error updating review', err);
      return res.status(500).send('Error updating review');
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

module.exports = { list, update, remove };
